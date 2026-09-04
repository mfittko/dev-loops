import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  parsePromoteCliArgs,
  parseSubmitCliArgs,
  parseStatusCliArgs,
  runPromote,
  runSubmit,
  runStatus,
} from "../../scripts/loop/steer-loop.mjs";
import { defaultStateFilePathForTarget } from "../../scripts/loop/_steering-state-file.mjs";

import { STEERING_KIND, STEERING_RESULT } from "../../packages/core/src/loop/steering.mjs";

const scriptPath = path.resolve("scripts/loop/steer-loop.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

function makeStdout() {
  let written = "";
  const stream = {
    write(chunk) {
      written += String(chunk);
    },
  };
  const read = () => JSON.parse(written);
  return { stream, read };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-steer-loop-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const writeJson = writeJsonHelper;

const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries);

// ---------------------------------------------------------------------------
// parseSubmitCliArgs
// ---------------------------------------------------------------------------

test("parseSubmitCliArgs parses all required flags", () => {
  const opts = parseSubmitCliArgs([
    "--run-id", "run-1",
    "--kind", "hard_constraint",
    "--directive", "No new deps",
    "--seq", "1",
  ]);
  assert.equal(opts.runId, "run-1");
  assert.equal(opts.kind, "hard_constraint");
  assert.equal(opts.directive, "No new deps");
  assert.equal(opts.seq, 1);
  assert.equal(opts.applyMode, "immediate");
  assert.equal(opts.loopState, "ready_to_rerequest_review");
});

test("parseSubmitCliArgs parses optional flags", () => {
  const opts = parseSubmitCliArgs([
    "--run-id", "run-1",
    "--kind", "preference",
    "--directive", "Prefer TS",
    "--seq", "2",
    "--loop-state", "waiting_for_ci",
    "--apply-mode", "next_safe_point",
    "--event-id", "evt-custom",
    "--state-file", "/tmp/state.json",
  ]);
  assert.equal(opts.loopState, "waiting_for_ci");
  assert.equal(opts.applyMode, "next_safe_point");
  assert.equal(opts.eventId, "evt-custom");
  assert.equal(opts.stateFile, "/tmp/state.json");
});


test("parseSubmitCliArgs allows directive values that begin with double dashes", () => {
  const opts = parseSubmitCliArgs([
    "--run-id", "run-1",
    "--kind", "hard_constraint",
    "--directive", "--foo must not appear in code",
    "--seq", "2",
  ]);
  assert.equal(opts.directive, "--foo must not appear in code");
});

test("parseSubmitCliArgs throws on missing --run-id", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--kind", "preference", "--directive", "x", "--seq", "1"]),
    /--run-id is required/,
  );
});

test("parseSubmitCliArgs throws on missing --kind", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--directive", "x", "--seq", "1"]),
    /--kind is required/,
  );
});

test("parseSubmitCliArgs throws on invalid --kind", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "bogus", "--directive", "x", "--seq", "1"]),
    /--kind must be one of/,
  );
});


test("parseSubmitCliArgs throws on unsafe --run-id", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "../bad", "--kind", "preference", "--directive", "x", "--seq", "1"]),
    /--run-id must contain only/,
  );
});

test("parseSubmitCliArgs throws on missing --directive", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "preference", "--seq", "1"]),
    /--directive is required/,
  );
});

test("parseSubmitCliArgs throws on missing --seq", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "preference", "--directive", "x"]),
    /--seq is required/,
  );
});

test("parseSubmitCliArgs throws on non-positive --seq", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "preference", "--directive", "x", "--seq", "0"]),
    /positive integer/,
  );
});

test("parseSubmitCliArgs throws on unknown argument", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--unknown-flag"]),
    /Unknown argument/,
  );
});

test("parseSubmitCliArgs throws on invalid --apply-mode", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "preference", "--directive", "x", "--seq", "1", "--apply-mode", "bogus"]),
    /--apply-mode must be one of/,
  );
});


test("parseSubmitCliArgs throws on invalid --loop-state", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--run-id", "r", "--kind", "preference", "--directive", "x", "--seq", "1", "--loop-state", "waiting_for_review"]),
    /--loop-state must be one of/,
  );
});

test("parseSubmitCliArgs rejects --loop-state in operator mode", () => {
  assert.throws(
    () => parseSubmitCliArgs(["--repo", "owner/repo", "--pr", "1", "--kind", "stop_at_next_safe_gate", "--directive", "Stop", "--seq", "1", "--loop-state", "waiting_for_ci"]),
    /--loop-state is low-level\/testing mode only/,
  );
});

test("parseSubmitCliArgs throws usage-bearing errors on invalid --repo slug", () => {
  let error = null;
  try {
    parseSubmitCliArgs(["--repo", "../../x/y", "--pr", "1", "--kind", "stop_at_next_safe_gate", "--directive", "Stop", "--seq", "1"]);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.match(error.message, /Repository slug|owner\/name|Invalid repository slug/i);
  assert.equal(typeof error.usage, "string");
  assert.match(error.usage, /steer-loop\.mjs submit/);
});

test("runSubmit rejects explicit --run-id that disagrees with --repo/--pr", async () => {
  const { stream } = makeStdout();
  await assert.rejects(
    () => runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--run-id", "pr-99",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop",
      "--seq", "1",
    ], { stdout: stream }),
    /run-id mismatch/,
  );
});

test("parseSubmitCliArgs sets help flag on --help", () => {
  const opts = parseSubmitCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

// ---------------------------------------------------------------------------
// parseStatusCliArgs
// ---------------------------------------------------------------------------

test("parseStatusCliArgs parses --run-id", () => {
  const opts = parseStatusCliArgs(["--run-id", "run-xyz"]);
  assert.equal(opts.runId, "run-xyz");
});

test("parseStatusCliArgs throws on missing --run-id", () => {
  assert.throws(() => parseStatusCliArgs([]), /--run-id is required/);
});

test("parseStatusCliArgs accepts --state-file", () => {
  const opts = parseStatusCliArgs(["--run-id", "r", "--state-file", "/tmp/s.json"]);
  assert.equal(opts.stateFile, "/tmp/s.json");
});

test("parseStatusCliArgs throws usage-bearing errors on invalid --repo slug", () => {
  let error = null;
  try {
    parseStatusCliArgs(["--repo", "../../x/y", "--pr", "1"]);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.match(error.message, /Repository slug|owner\/name|Invalid repository slug/i);
  assert.equal(typeof error.usage, "string");
  assert.match(error.usage, /Choose exactly one target mode/);
});

test("parseStatusCliArgs throws on unsafe --run-id", () => {
  assert.throws(() => parseStatusCliArgs(["--run-id", "../../bad"]), /--run-id must contain only/);
});

test("parseStatusCliArgs rejects mixing --run-id with --repo/--pr", () => {
  assert.throws(
    () => parseStatusCliArgs(["--run-id", "run-xyz", "--repo", "owner/repo", "--pr", "55"]),
    /Choose exactly one target mode/,
  );
});

test("defaultStateFilePathForTarget rejects unsafe repo segments consistently", () => {
  for (const repo of ["owner/..", "./repo", "owner/repo\\evil", "owner/repo/extra"]) {
    assert.throws(
      () => defaultStateFilePathForTarget({ repo, pr: 55 }),
      /Invalid repo slug for steering target path/,
    );
  }
});


test("parseStatusCliArgs throws on unknown argument", () => {
  assert.throws(() => parseStatusCliArgs(["--unknown"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// parsePromoteCliArgs
// ---------------------------------------------------------------------------

test("parsePromoteCliArgs parses --run-id and --loop-state", () => {
  const opts = parsePromoteCliArgs(["--run-id", "run-xyz", "--loop-state", "ready_to_rerequest_review"]);
  assert.equal(opts.runId, "run-xyz");
  assert.equal(opts.loopState, "ready_to_rerequest_review");
});

test("parsePromoteCliArgs requires --loop-state", () => {
  assert.throws(() => parsePromoteCliArgs(["--run-id", "run-xyz"]), /--loop-state is required/);
});

// ---------------------------------------------------------------------------
// runSubmit — immediate application
// ---------------------------------------------------------------------------

test("runSubmit applies steering immediately at a safe loop state", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-1",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.steeringState.effectiveStack.length, 1);
    assert.equal(output.steeringState.events.length, 1);

    // Verify persistence
    const savedRaw = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(savedRaw.effectiveStack.length, 1);
    assert.equal(savedRaw.nextSeq, 2);
  });
});

test("runSubmit applies preference at waiting_for_copilot_review", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-2",
      "--kind", "preference",
      "--directive", "Prefer TypeScript",
      "--seq", "1",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
  });
});

test("runSubmit applies stop_at_next_safe_gate at a safe point", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-3",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before next review cycle",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.steeringState.effectiveStack[0].kind, STEERING_KIND.STOP_AT_NEXT_SAFE_GATE);
  });
});

test.skip("runSubmit operator mode returns an applied-now acknowledgement envelope from an authoritative inspection", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const { stream, read } = makeStdout();
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });
    const { env } = await writeGhStub(dir, [
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 55,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 55,
          headRefOid: "abc123",
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/reviews"],
        stdout: `${JSON.stringify([{ id: 1, state: "COMMENTED", commit_id: "abc123" }])}\n`,
      },
    ]);

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir, env });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.runId, "pr-55");
    assert.equal(output.acknowledgement.disposition, "applied_now");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.acknowledgement.inspectedState, "waiting_for_copilot_review");
    assert.equal(output.acknowledgement.safePointCategory, "immediate");
    assert.equal(output.acknowledgement.effectiveNow, true);
    assert.match(output.acknowledgement.readbackPath.inspection, /node scripts\/loop\/inspect-run\.mjs --repo "owner\/repo" --pr "55" --steering-state-file/);
    assert.doesNotMatch(output.acknowledgement.readbackPath.inspection, /--state-file/);
    assert.match(output.acknowledgement.readbackPath.steeringStatus, /node scripts\/loop\/steer-loop\.mjs status --repo "owner\/repo" --pr "55" --state-file/);
    assert.doesNotMatch(output.acknowledgement.readbackPath.steeringStatus, /--steering-state-file/);
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.steeringState.effectiveStack.length, 1);
  });
});

test("runSubmit operator mode rejects degraded snapshot inputs and keeps a deterministic success envelope", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const copilotPath = path.join(dir, "copilot.json");
    const reviewerPath = path.join(dir, "reviewer.json");
    const { stream, read } = makeStdout();

    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      copilotReviewPresent: false,
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

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.equal(output.acknowledgement.reasonCode, "inspection_not_authoritative");
    assert.match(output.acknowledgement.reason, /degraded or stale/i);
    assert.equal(output.result.result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.equal(output.result.reasonCode, "inspection_not_authoritative");
    assert.equal(output.steeringState.events.length, 0);
  });
});

test("runSubmit operator mode rejects checkpoint-only inspection snapshots and keeps a deterministic success envelope", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = path.join(dir, "tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json");
    const stateFile = path.join(dir, "state.json");
    const { stream, read } = makeStdout();

    await writeJson(checkpointPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-20T12:00:00.000Z",
      waitCycles: 2,
      headSha: "abc123",
    });

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir, env: { ...process.env, PATH: dir } });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.match(output.acknowledgement.reason, /could not be confidently identified|degraded or stale/i);
    assert.deepEqual(output.steeringState.events, []);
  });
});

test("runSubmit operator mode rejects malformed steering state files with a deterministic success envelope", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "broken-state.json");
    const { stream, read } = makeStdout();
    await writeFile(stateFile, "{not valid json\n", "utf8");

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.match(output.acknowledgement.reason, /existing steering state is invalid/i);
    assert.deepEqual(output.steeringState.target, { repo: "owner/repo", pr: 55 });
    assert.deepEqual(output.steeringState.events, []);
  });
});

test("runSubmit operator mode rejects mismatched steering state files with a deterministic success envelope", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, ".pi", "steering", "owner", "repo", "pr-55.json");
    const { stream, read } = makeStdout();

    await writeJson(stateFile, {
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

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.match(output.acknowledgement.reason, /state file does not match the requested target/i);
    assert.match(output.acknowledgement.readbackPath.steeringStatus, /node scripts\/loop\/steer-loop\.mjs status --repo "owner\/repo" --pr "55" --state-file/);
    assert.equal(output.steeringState.runId, "pr-55");
    assert.deepEqual(output.steeringState.target, { repo: "owner/repo", pr: 55 });
    assert.deepEqual(output.steeringState.events, []);
  });
});

test("runSubmit operator mode rejects conflict-marked inspections with a deterministic success envelope", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = path.join(dir, "tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json");
    const stateFile = path.join(dir, "state.json");
    const copilotPath = path.join(dir, "copilot.json");
    const reviewerPath = path.join(dir, "reviewer.json");
    const { stream, read } = makeStdout();

    await writeJson(checkpointPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "stop",
      copilotState: "review_request_unavailable",
      reviewerState: "waiting_for_author_followup",
      reason: "review_unavailable",
      timestamp: "2026-05-20T12:00:00.000Z",
      waitCycles: 2,
      headSha: "abc123",
    });
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
      prHeadSha: "abc123",
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
    });

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_UNSAFE_NOW);
    assert.match(output.acknowledgement.reason, /degraded or stale/i);
    assert.deepEqual(output.steeringState.events, []);
  });
});

test("runSubmit operator mode rejects --apply-mode overrides in the first external slice", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const { stream, read } = makeStdout();
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });
    const { env } = await writeGhStub(dir, [
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 55,
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 55,
          headRefOid: "abc123",
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/reviews"],
        stdout: `${JSON.stringify([{ id: 1, state: "COMMENTED", commit_id: "abc123" }])}\n`,
      },
    ]);

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--apply-mode", "next_safe_point",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir, env });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
    assert.match(output.acknowledgement.reason, /does not accept --apply-mode overrides/i);
    assert.deepEqual(output.steeringState.events, []);
  });
});

test.skip("runSubmit operator mode queues stop_at_next_safe_gate for the next safe point from authoritative inspection", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const { stream, read } = makeStdout();
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });
    const { env } = await writeGhStub(dir, [
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: true,
          state: "OPEN",
          number: 55,
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: true,
          state: "OPEN",
          number: 55,
          headRefOid: "abc123",
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/reviews"],
        stdout: '[]\n',
      },
    ]);

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before the next safe gate",
      "--seq", "1",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir, env });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "queued_for_safe_point");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
    assert.equal(output.acknowledgement.inspectedState, "pr_draft");
    assert.equal(output.acknowledgement.safePointCategory, "next_point");
    assert.equal(output.acknowledgement.effectiveNow, false);
    assert.equal(output.result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
    assert.match(output.acknowledgement.readbackPath.inspection, /node scripts\/loop\/inspect-run\.mjs --repo "owner\/repo" --pr "55" --steering-state-file/);
    assert.match(output.acknowledgement.readbackPath.steeringStatus, /node scripts\/loop\/steer-loop\.mjs status --repo "owner\/repo" --pr "55" --state-file/);
    assert.equal(output.steeringState.queuedEvents.length, 1);
    assert.deepEqual(output.steeringState.target, { repo: "owner/repo", pr: 55 });
  });
});

test("runSubmit operator mode rejects non-stop directives with the same top-level success shape", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const copilotPath = path.join(dir, "copilot.json");
    const reviewerPath = path.join(dir, "reviewer.json");
    const { stream, read } = makeStdout();

    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      copilotReviewPresent: false,
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

    await runSubmit([
      "--repo", "owner/repo",
      "--pr", "55",
      "--kind", "preference",
      "--directive", "Prefer TypeScript",
      "--seq", "1",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.acknowledgement.disposition, "rejected");
    assert.equal(output.acknowledgement.resultCode, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
    assert.match(output.acknowledgement.reason, /only stop_at_next_safe_gate/i);
    assert.equal(output.result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
    assert.deepEqual(output.steeringState.events, []);
  });
});

// ---------------------------------------------------------------------------
// runSubmit — queued for safe point
// ---------------------------------------------------------------------------

test("runSubmit queues steering when loop is in unresolved_feedback_present", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-4",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "unresolved_feedback_present",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
    assert.equal(output.steeringState.queuedEvents.length, 1);
    assert.equal(output.steeringState.effectiveStack.length, 0);
  });
});

test("runSubmit queues steering when applyMode is next_safe_point even at safe point", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-5",
      "--kind", "clarification",
      "--directive", "Clarify scope",
      "--seq", "1",
      "--loop-state", "ready_to_rerequest_review",
      "--apply-mode", "next_safe_point",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
  });
});

// ---------------------------------------------------------------------------
// runSubmit — unsafe rejection
// ---------------------------------------------------------------------------

test("runSubmit rejects steering when loop is done", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-6",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "done",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
  });
});

test("runSubmit routes blocked_needs_user_decision to needs_human_decision", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "run-7",
      "--kind", "preference",
      "--directive", "Prefer X",
      "--seq", "1",
      "--loop-state", "blocked_needs_user_decision",
      "--state-file", path.join(dir, "state.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.result.result, STEERING_RESULT.NEEDS_HUMAN_DECISION);
  });
});

// ---------------------------------------------------------------------------
// runSubmit — conflicting/invalid steering
// ---------------------------------------------------------------------------

test("runSubmit rejects duplicate hard_constraint directives", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Submit first event
    const { stream: s1, read: r1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-8",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });
    assert.equal(r1().result.result, STEERING_RESULT.APPLIED_NOW);

    // Submit duplicate
    const { stream: s2, read: r2 } = makeStdout();
    await runSubmit([
      "--run-id", "run-8",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "2",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
    assert.match(output.result.reason, /[Dd]uplicate/);
  });
});

test("runSubmit preserves deterministic sequencing for repeat stop_at_next_safe_gate no-op submissions", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    const { stream: s1, read: r1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-stop-seq",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop at the next safe gate",
      "--seq", "1",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });
    assert.equal(r1().result.result, STEERING_RESULT.APPLIED_NOW);

    const { stream: s2, read: r2 } = makeStdout();
    await runSubmit([
      "--run-id", "run-stop-seq",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop again",
      "--seq", "2",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
    assert.match(output.result.reason, /already effective/i);
    assert.equal(output.steeringState.effectiveStack.length, 1);
    assert.equal(output.steeringState.events.length, 2);
    assert.equal(output.steeringState.nextSeq, 3);
  });
});

test("runSubmit rejects out-of-order seq", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Submit seq=5 first
    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-9",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "5",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    // Now try seq=3 (out of order)
    const { stream: s2, read: r2 } = makeStdout();
    await runSubmit([
      "--run-id", "run-9",
      "--kind", "clarification",
      "--directive", "Some clarification",
      "--seq", "3",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
    assert.match(output.result.reason, /out of order/);
  });
});

// ---------------------------------------------------------------------------
// runSubmit — durable state persistence and reload
// ---------------------------------------------------------------------------

test("runSubmit persists state that survives reload across calls", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Submit seq=1
    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-10",
      "--kind", "hard_constraint",
      "--directive", "Constraint A",
      "--seq", "1",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    // Submit seq=2 — state loaded from disk
    const { stream: s2, read: r2 } = makeStdout();
    await runSubmit([
      "--run-id", "run-10",
      "--kind", "hard_constraint",
      "--directive", "Constraint B",
      "--seq", "2",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.result.result, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.steeringState.effectiveStack.length, 2);
    assert.equal(output.steeringState.nextSeq, 3);

    // Verify both are persisted
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.events.length, 2);
    assert.equal(saved.effectiveStack.length, 2);
  });
});


test("runSubmit creates the default steering directory before acquiring the lock", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runSubmit([
      "--run-id", "default-path-run",
      "--kind", "hard_constraint",
      "--directive", "Constraint A",
      "--seq", "1",
      "--loop-state", "ready_to_rerequest_review",
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);

    const defaultStatePath = path.join(dir, ".pi", "steering", "default-path-run.json");
    const saved = JSON.parse(await readFile(defaultStatePath, "utf8"));
    assert.equal(saved.events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// runSubmit — run-id / state-file mismatch
// ---------------------------------------------------------------------------

test("runSubmit rejects when --state-file contains a different run-id than --run-id", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Seed the file with run-A
    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-A",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    // Attempt to submit as run-B against the same file
    await assert.rejects(
      () => runSubmit([
        "--run-id", "run-B",
        "--kind", "preference",
        "--directive", "Prefer Go",
        "--seq", "1",
        "--loop-state", "waiting_for_ci",
        "--state-file", stateFile,
      ], { stdout: { write() {} }, cwd: dir }),
      /run-id mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// runPromote
// ---------------------------------------------------------------------------

test("runPromote explicitly promotes queued steering and persists it", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    await writeJson(stateFile, {
      runId: "run-promote-1",
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "run-promote-1",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      effectiveStack: [],
      queuedEvents: [{
        eventId: "evt-001",
        runId: "run-promote-1",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      resultHistory: [{
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      }],
      latestResult: {
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      },
      nextSeq: 2,
    });

    const { stream, read } = makeStdout();
    await runPromote([
      "--run-id", "run-promote-1",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.promotedCount, 1);
    assert.equal(output.steeringState.queuedEvents.length, 0);
    assert.equal(output.steeringState.effectiveStack.length, 1);
    assert.equal(output.steeringState.latestResult.result, "applied_now");

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.queuedEvents.length, 0);
    assert.equal(persisted.effectiveStack.length, 1);
    assert.equal(persisted.latestResult.result, "applied_now");
  });
});


test("runPromote reloads state under the steering lock before persisting promotion", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const lockDir = `${stateFile}.lock`;
    await writeJson(stateFile, {
      runId: "run-promote-2",
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });
    await mkdir(lockDir, { recursive: true });
    await writeJson(path.join(lockDir, "owner.json"), { pid: process.pid, acquiredAt: "2026-05-31T00:00:00.000Z" });

    const { stream, read } = makeStdout();
    const promotePromise = runPromote([
      "--run-id", "run-promote-2",
      "--loop-state", "ready_to_rerequest_review",
      "--state-file", stateFile,
    ], { stdout: stream, cwd: dir });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeJson(stateFile, {
      runId: "run-promote-2",
      schemaVersion: 1,
      events: [{
        eventId: "evt-002",
        runId: "run-promote-2",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      effectiveStack: [],
      queuedEvents: [{
        eventId: "evt-002",
        runId: "run-promote-2",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      resultHistory: [{
        eventId: "evt-002",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      }],
      latestResult: {
        eventId: "evt-002",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      },
      nextSeq: 2,
    });
    await rm(lockDir, { recursive: true, force: true });

    await promotePromise;

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.promotedCount, 1);
    assert.equal(output.steeringState.effectiveStack.length, 1);

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.queuedEvents.length, 0);
    assert.equal(persisted.effectiveStack.length, 1);
    assert.equal(persisted.latestResult.result, "applied_now");
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

test("runStatus returns empty status when no state file exists", async () => {
  await withTempDir(async (dir) => {
    const { stream, read } = makeStdout();

    await runStatus([
      "--run-id", "run-status-1",
      "--state-file", path.join(dir, "nonexistent.json"),
    ], { stdout: stream, cwd: dir });

    const output = read();
    assert.equal(output.ok, true);
    assert.equal(output.status.runId, "run-status-1");
    assert.equal(output.status.eventCount, 0);
    assert.equal(output.status.effectiveStackCount, 0);
    assert.equal(output.status.queuedCount, 0);
    assert.equal(output.status.latestResult, null);
  });
});

test("runStatus shows current steering status after submissions", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Submit an event
    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-status-2",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    // Check status
    const { stream: s2, read: r2 } = makeStdout();
    await runStatus([
      "--run-id", "run-status-2",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.ok, true);
    assert.equal(output.status.eventCount, 1);
    assert.equal(output.status.effectiveStackCount, 1);
    assert.equal(output.status.queuedCount, 0);
    assert.equal(output.status.latestResult.result, STEERING_RESULT.APPLIED_NOW);
    assert.equal(output.status.effectiveConstraints.hardConstraints[0], "No new deps");
  });
});

test("runStatus shows queued events before they are promoted", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-status-3",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "1",
      "--loop-state", "unresolved_feedback_present",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    const { stream: s2, read: r2 } = makeStdout();
    await runStatus([
      "--run-id", "run-status-3",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.status.queuedCount, 1);
    assert.equal(output.status.effectiveStackCount, 0);
    assert.equal(output.status.latestResult.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
  });
});

test("runStatus shows stop_at_next_safe_gate in effective constraints", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-status-4",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before next review pass",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    const { stream: s2, read: r2 } = makeStdout();
    await runStatus([
      "--run-id", "run-status-4",
      "--state-file", stateFile,
    ], { stdout: s2, cwd: dir });

    const output = r2();
    assert.equal(output.status.effectiveConstraints.stopAtNextSafeGate, true);
  });
});

test("runStatus rejects when --state-file contains a different run-id than --run-id", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");

    // Seed the file with run-status-A
    const { stream: s1 } = makeStdout();
    await runSubmit([
      "--run-id", "run-status-A",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ], { stdout: s1, cwd: dir });

    // Attempt to inspect as run-status-B against the same file
    await assert.rejects(
      () => runStatus([
        "--run-id", "run-status-B",
        "--state-file", stateFile,
      ], { stdout: { write() {} }, cwd: dir }),
      /run-id mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI binary — argument errors
// ---------------------------------------------------------------------------

test("steer-loop.mjs exits non-zero on missing subcommand arguments (submit)", async () => {
  const result = await runNode(["submit", "--run-id", "r"]);
  assert.equal(result.code, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert.ok(typeof err.error === "string" && err.error.length > 0);
  assert.equal(err.hint, "run with --help for usage");
});

test("steer-loop.mjs exits non-zero on unknown subcommand", async () => {
  const result = await runNode(["bogus-subcommand"]);
  assert.equal(result.code, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
});

test("steer-loop.mjs prints top-level usage for --help", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /subcommand/);
});

test("steer-loop.mjs submit --help prints usage", async () => {
  const result = await runNode(["submit", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--kind/);
});

test("steer-loop.mjs status --help prints usage", async () => {
  const result = await runNode(["status", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--run-id/);
  assert.match(result.stdout, /Choose exactly one target mode/);
  assert.doesNotMatch(result.stdout, /Required:\n  --run-id <id>[\s\S]*--repo <owner\/name>[\s\S]*--pr <number>/);
});

test("steer-loop.mjs promote --help prints usage", async () => {
  const result = await runNode(["promote", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--loop-state/);
  assert.match(result.stdout, /promotedCount/);
});

// ---------------------------------------------------------------------------
// CLI binary — run-id / state-file mismatch
// ---------------------------------------------------------------------------

test("steer-loop.mjs submit exits non-zero on run-id/state-file mismatch", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "mismatch-state.json");

    // Seed with run-X
    const seed = await runNode([
      "submit",
      "--run-id", "run-X",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ]);
    assert.equal(seed.code, 0);

    // Submit as run-Y against the same file
    const mismatch = await runNode([
      "submit",
      "--run-id", "run-Y",
      "--kind", "preference",
      "--directive", "Prefer Go",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ]);
    assert.equal(mismatch.code, 1);
    const err = JSON.parse(mismatch.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /run-id mismatch/);
  });
});

test("steer-loop.mjs status exits non-zero on run-id/state-file mismatch", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "mismatch-state.json");

    // Seed with run-X
    const seed = await runNode([
      "submit",
      "--run-id", "run-X",
      "--kind", "preference",
      "--directive", "Prefer TS",
      "--seq", "1",
      "--loop-state", "waiting_for_ci",
      "--state-file", stateFile,
    ]);
    assert.equal(seed.code, 0);

    // Status as run-Y against the same file
    const mismatch = await runNode([
      "status",
      "--run-id", "run-Y",
      "--state-file", stateFile,
    ]);
    assert.equal(mismatch.code, 1);
    const err = JSON.parse(mismatch.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /run-id mismatch/);
  });
});

// ---------------------------------------------------------------------------
// CLI binary — end-to-end submit and status
// ---------------------------------------------------------------------------

test("steer-loop.mjs submit + status end-to-end via CLI", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "e2e-state.json");

    const submit = await runNode([
      "submit",
      "--run-id", "e2e-run",
      "--kind", "hard_constraint",
      "--directive", "No new deps",
      "--seq", "1",
      "--loop-state", "pr_ready_no_feedback",
      "--state-file", stateFile,
    ]);

    assert.equal(submit.code, 0);
    const submitOut = JSON.parse(submit.stdout);
    assert.equal(submitOut.ok, true);
    assert.equal(submitOut.result.result, STEERING_RESULT.APPLIED_NOW);

    const status = await runNode([
      "status",
      "--run-id", "e2e-run",
      "--state-file", stateFile,
    ]);

    assert.equal(status.code, 0);
    const statusOut = JSON.parse(status.stdout);
    assert.equal(statusOut.ok, true);
    assert.equal(statusOut.status.eventCount, 1);
    assert.equal(statusOut.status.effectiveStackCount, 1);
    assert.deepEqual(statusOut.status.effectiveConstraints.hardConstraints, ["No new deps"]);
  });
});
