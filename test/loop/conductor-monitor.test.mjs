import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runConductorMonitor, isPrHealthy } from "../../scripts/loop/conductor-monitor.mjs";
import { makeGhMock, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/conductor-monitor.mjs");
const mixedThreadsFixturePath = path.resolve("packages/core/test/fixtures/github/review-threads/mixed-threads.json");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

function emptyThreadsPayload() {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
          },
        },
      },
    },
  });
}

function buildPrListEntry(pr) {
  return {
    number: pr.number,
    title: pr.title ?? `PR ${pr.number}`,
    url: pr.url ?? `https://github.com/${pr.repo ?? "owner/repo"}/pull/${pr.number}`,
    isDraft: Boolean(pr.isDraft),
    headRefName: pr.headRefName ?? `copilot/pr-${pr.number}`,
    author: { login: pr.authorLogin ?? "copilot-swe-agent" },
  };
}

function buildPrViewEntry(pr) {
  return {
    isDraft: Boolean(pr.isDraft),
    state: pr.state ?? "OPEN",
    number: pr.number,
    reviews: pr.reviews ?? [],
    statusCheckRollup: pr.statusCheckRollup ?? [],
  };
}

function buildRequestedReviewersPayload(pr) {
  if (Array.isArray(pr.requestedReviewers)) {
    return JSON.stringify({ users: pr.requestedReviewers, teams: [] });
  }

  return pr.requestCopilot === true
    ? JSON.stringify({ users: [{ login: "copilot-pull-request-reviewer[bot]" }], teams: [] })
    : JSON.stringify({ users: [], teams: [] });
}

function buildGhEntries({ repo = "owner/repo", prs }) {
  const entries = [{
    assertArgs: ["pr", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
    stdout: `${JSON.stringify(prs.map((pr) => buildPrListEntry({ ...pr, repo })))}\n`,
  }];

  for (const pr of prs) {
    entries.push(
      {
        assertArgs: ["pr", "view", String(pr.number), "--repo", repo],
        stdout: `${JSON.stringify(buildPrViewEntry(pr))}\n`,
      },
      {
        assertArgs: ["api", `repos/${repo}/pulls/${pr.number}/requested_reviewers`],
        stdout: `${buildRequestedReviewersPayload(pr)}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${pr.threadsPayload ?? emptyThreadsPayload()}\n`,
      },
    );
  }

  return entries;
}

async function createAutoResumeRoots(tempDir) {
  const repoRoot = path.join(tempDir, "repo");
  const sessionsRoot = path.join(tempDir, "sessions-root");
  const asyncRunsRoot = path.join(tempDir, "async-runs-root");
  const asyncResultsRoot = path.join(tempDir, "async-results-root");

  await mkdir(path.join(repoRoot, "tmp", "worktrees"), { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(asyncRunsRoot, { recursive: true });
  await mkdir(asyncResultsRoot, { recursive: true });

  return { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot };
}

async function writeSessionRun({
  sessionsRoot,
  runId,
  childIndex = 0,
  agent = "dev-loop",
  cwd,
  outputText = null,
  exitCode = 0,
  timestampMs = 1700000000000,
  writeOutputArtifact = true,
}) {
  const sessionRoot = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session");
  const artifactsDir = path.join(sessionRoot, "subagent-artifacts");
  const sessionDir = path.join(sessionRoot, runId, `run-${childIndex}`);
  const artifactBase = `${runId}_${agent}_${childIndex}`;
  const metaPath = path.join(artifactsDir, `${artifactBase}_meta.json`);
  const outputArtifactPath = path.join(artifactsDir, `${artifactBase}_output.md`);
  const sessionPath = path.join(sessionDir, "session.jsonl");

  await mkdir(artifactsDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(metaPath, `${JSON.stringify({ runId, agent, exitCode, timestamp: timestampMs }, null, 2)}\n`, "utf8");
  if (writeOutputArtifact && outputText !== null) {
    await writeFile(outputArtifactPath, outputText, "utf8");
  }
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id: `${runId}-session`, timestamp: "2026-06-03T00:00:00.000Z", cwd })}\n`,
    "utf8",
  );

  return { metaPath, outputArtifactPath, sessionPath };
}

async function writeAsyncRun({
  asyncRunsRoot,
  runId,
  state = "running",
  childIndex = 0,
  childStatus = state,
  agent = "dev-loop",
  cwd,
  outputText = null,
  sessionPath = null,
  timestampMs = 1700000000000,
}) {
  const asyncDir = path.join(asyncRunsRoot, runId);
  const statusPath = path.join(asyncDir, "status.json");
  const outputPath = path.join(asyncDir, `output-${childIndex}.log`);
  const eventsPath = path.join(asyncDir, "events.jsonl");

  await mkdir(asyncDir, { recursive: true });
  await writeFile(statusPath, `${JSON.stringify({
    runId,
    mode: "single",
    state,
    cwd,
    lastUpdate: timestampMs,
    startedAt: timestampMs - 5000,
    steps: [
      {
        agent,
        status: childStatus,
        sessionFile: sessionPath,
      },
    ],
    outputFile: outputPath,
  }, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, "", "utf8");
  if (outputText !== null) {
    await writeFile(outputPath, outputText, "utf8");
  }

  return { statusPath, outputPath, eventsPath };
}

async function runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo, runChild }) {
  return runConductorMonitor(
    { repo, autoResume: true },
    {
      runChild,
      repoRoot,
      sessionRoots: [sessionsRoot],
      asyncRunRoots: [asyncRunsRoot],
      asyncResultRoots: [asyncResultsRoot],
    },
  );
}

test("conductor-monitor reports queue_complete when no open PRs exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-empty-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);

    const result = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.repo, "owner/repo");
    assert.equal(payload.prCount, 0);
    assert.equal(payload.queueStatus, "queue_complete");
    assert.equal(payload.needsAttentionCount, 0);
    assert.deepEqual(payload.prs, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume keeps queue_complete semantics when no open PRs exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-auto-resume-empty-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);
    env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
    env.PI_SUBAGENT_ASYNC_RUNS_DIR = asyncRunsRoot;
    env.PI_SUBAGENT_ASYNC_RESULTS_DIR = asyncResultsRoot;

    const result = await runNode(["--repo", "owner/repo", "--auto-resume"], { env, cwd: repoRoot });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.queueStatus, "queue_complete");
    assert.equal(payload.autoResumeRequested, true);
    assert.equal(payload.orphanedPrCount, 0);
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
    assert.deepEqual(payload.resumePlans, []);
    assert.deepEqual(payload.needsManualAttention, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor reports gh runtime failures without a usage payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-gh-failure-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stderr: "gh exploded\n",
      exitCode: 1,
    }]);

    const result = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /gh command failed/i);
    assert.equal(Object.hasOwn(payload, "usage"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor fails closed when gh pr list returns non-array JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-list-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "{}\n",
    }]);

    const result = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /expected an array/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor reports monitoring when open PRs are still in healthy wait states", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-waiting-"));

  try {
    const env = await writeGhStub(tempDir, buildGhEntries({
      prs: [
        {
          number: 17,
          title: "Add monitor status report",
          requestCopilot: true,
        },
      ],
    }));

    const result = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.needsAttentionCount, 0);
    assert.equal(payload.summary.waiting, 1);
    assert.equal(payload.summary.needsAttention, 0);
    assert.equal(payload.prs[0].number, 17);
    assert.equal(payload.prs[0].state, "waiting_for_copilot_review");
    assert.equal(payload.prs[0].loopDisposition, "pending");
    assert.equal(payload.prs[0].needsAttention, false);
    assert.equal(payload.prs[0].snapshot.copilotReviewRequestStatus, "requested");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores invalid async JSON side artifacts instead of crashing the scan", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-async-json-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const badAsyncDir = path.join(asyncRunsRoot, "run-bad-json-40");
    await mkdir(badAsyncDir, { recursive: true });
    await writeFile(path.join(badAsyncDir, "status.json"), "{not valid json\n", "utf8");
    await writeFile(path.join(badAsyncDir, "events.jsonl"), "", "utf8");
    await writeFile(path.join(badAsyncDir, "output-0.log"), "Active PR: owner/repo#40\n", "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 40, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores malformed session artifact meta JSON instead of crashing the scan", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-meta-json-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const badArtifactsDir = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session", "subagent-artifacts");
    await mkdir(badArtifactsDir, { recursive: true });
    await writeFile(path.join(badArtifactsDir, "run-bad-meta-99_dev-loop_0_meta.json"), "{not valid json\n", "utf8");
    await writeFile(path.join(badArtifactsDir, "run-bad-meta-99_dev-loop_0_output.md"), "Active PR: owner/repo#99\n", "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 44, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores malformed async result JSON instead of crashing the scan", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-result-json-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeFile(path.join(asyncResultsRoot, "run-bad-result-45.json"), "{not valid json\n", "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 45, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor flags unresolved-feedback PRs as needing attention while preserving pending waits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-attention-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const env = await writeGhStub(tempDir, buildGhEntries({
      prs: [
        {
          number: 17,
          title: "Add conductor monitor wrapper",
          reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
          threadsPayload: mixedThreadsFixture,
        },
        {
          number: 18,
          title: "Document monitor pattern",
          requestCopilot: true,
        },
      ],
    }));

    const result = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.queueStatus, "attention_needed");
    assert.equal(payload.needsAttentionCount, 1);
    assert.equal(payload.summary.waiting, 1);
    assert.equal(payload.summary.needsAttention, 1);
    assert.equal(payload.summary.blocked, 0);

    const actionable = payload.prs.find((pr) => pr.number === 17);
    const waiting = payload.prs.find((pr) => pr.number === 18);

    assert.equal(actionable.state, "unresolved_feedback_present");
    assert.equal(actionable.loopDisposition, "unresolved_feedback");
    assert.equal(actionable.needsAttention, true);
    assert.equal(actionable.snapshot.unresolvedThreadCount, 2);
    assert.equal(actionable.snapshot.actionableThreadCount, 1);

    assert.equal(waiting.state, "waiting_for_copilot_review");
    assert.equal(waiting.loopDisposition, "pending");
    assert.equal(waiting.needsAttention, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores malformed session headers instead of crashing the scan", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-session-json-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const badSessionRoot = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session", "run-bad-session-41", "run-0");
    const badArtifactsDir = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session", "subagent-artifacts");
    await mkdir(badSessionRoot, { recursive: true });
    await mkdir(badArtifactsDir, { recursive: true });
    await writeFile(path.join(badSessionRoot, "session.jsonl"), "{bad session header\n", "utf8");
    await writeFile(
      path.join(badArtifactsDir, "run-bad-session-41_dev-loop_0_meta.json"),
      `${JSON.stringify({ runId: "run-bad-session-41", agent: "dev-loop", exitCode: 0, timestamp: 1700000009000 }, null, 2)}
`,
      "utf8",
    );
    await writeFile(path.join(badArtifactsDir, "run-bad-session-41_dev-loop_0_output.md"), "Active PR: owner/repo#41\n", "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 41, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores parse-failed artifacts that do not match the live open PR set", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-nonopen-manual-ignore-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-missing-99",
      cwd: repoRoot,
      timestampMs: 1700000010000,
      outputText: "Active PR: owner/repo#99\n",
      writeOutputArtifact: false,
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-missing-99",
      state: "complete",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000010500,
      outputText: "Active PR: owner/repo#99\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 42, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.queueStatus, "monitoring");
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed when an active matching run cannot be proven newer by timestamp", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-indeterminate-active-run-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-complete-43",
      cwd: repoRoot,
      timestampMs: 1700000011000,
      outputText: "Active PR: owner/repo#43\nArtifact state: open\nLoop state: waiting_for_copilot_review\n",
    });
    const { statusPath } = await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-active-43",
      state: "running",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000012000,
      outputText: "Active PR: owner/repo#43\nLoop state: waiting_for_copilot_review\n",
    });
    const activeStatus = JSON.parse(await readFile(statusPath, "utf8"));
    delete activeStatus.lastUpdate;
    delete activeStatus.startedAt;
    await writeFile(statusPath, `${JSON.stringify(activeStatus, null, 2)}
`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 43, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].pr, 43);
    assert.equal(payload.needsManualAttention[0].reason, "artifact_live_state_conflict");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume preserves artifact run ids that contain underscores", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-underscore-run-id-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "pr_55",
      cwd: repoRoot,
      timestampMs: 1700000013000,
      outputText: "Active PR: owner/repo#55\nArtifact state: open\nLoop state: unresolved_feedback_present\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 55,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].runId, "pr_55");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed when run exit state cannot be proven", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-unknown-run-state-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const sessionRoot = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session");
    const artifactsDir = path.join(sessionRoot, "subagent-artifacts");
    const runDir = path.join(sessionRoot, "run-unknown-56", "run-0");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "run-unknown-56_dev-loop_0_output.md"), "Active PR: owner/repo#56\nArtifact state: open\nLoop state: waiting_for_copilot_review\n", "utf8");
    await writeFile(path.join(runDir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "run-unknown-56-session", timestamp: "2026-06-03T00:00:00.000Z", cwd: repoRoot })}\n`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 56, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].pr, 56);
    assert.equal(payload.needsManualAttention[0].reason, "artifact_live_state_conflict");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume preserves the stronger failed run state when evidence conflicts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-run-state-priority-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-failed-57",
      cwd: repoRoot,
      timestampMs: 1700000014000,
      exitCode: 1,
      outputText: "Active PR: owner/repo#57\nArtifact state: open\nLoop state: unresolved_feedback_present\n",
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-failed-57",
      state: "complete",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000014500,
      outputText: "Active PR: owner/repo#57\nLoop state: unresolved_feedback_present\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 57,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].runState, "failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume uses grouped result summaries as the artifactPath when no output artifact exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-grouped-summary-path-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const summaryPath = path.join(asyncResultsRoot, "run-summary-58.json");
    await writeFile(summaryPath, `${JSON.stringify({
      runId: "run-summary-58",
      agent: "dev-loop",
      state: "complete",
      cwd: repoRoot,
      summary: [
        "Run: run-summary-58",
        "State: complete",
        "Agent: dev-loop",
        "Active PR: owner/repo#58",
        "Artifact state: open",
        "Loop state: waiting_for_copilot_review",
      ].join("\n"),
      results: [{
        agent: "dev-loop",
        output: [
          "Run: run-summary-58",
          "State: complete",
          "Agent: dev-loop",
          "Active PR: owner/repo#58",
          "Artifact state: open",
          "Loop state: waiting_for_copilot_review",
        ].join("\n"),
      }],
    }, null, 2)}
`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 58, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].artifactPath, summaryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume reuses grouped result summaries when acceptance reporting drops the output artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-reporting-fallback-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const resultPath = path.join(asyncResultsRoot, "run-reporting-58b.json");
    const finalApprovalSummary = [
      "Status: stopped at final human approval boundary",
      "Routed strategy: final_approval",
      "PR: https://github.com/owner/repo/pull/58",
      "Next recommended action: human reviews/approves PR #58",
    ].join("\n");

    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-reporting-58b",
      cwd: repoRoot,
      timestampMs: 1700000014550,
      exitCode: 1,
      outputText: finalApprovalSummary,
      writeOutputArtifact: false,
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-reporting-58b",
      state: "complete",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000014600,
      outputText: finalApprovalSummary,
    });
    await writeFile(resultPath, `${JSON.stringify({
      runId: "run-reporting-58b",
      agent: "dev-loop",
      state: "complete",
      cwd: repoRoot,
      summary: finalApprovalSummary,
      results: [{
        agent: "dev-loop",
        artifactPaths: {
          output: path.join(asyncResultsRoot, "missing-run-reporting-58b_output.md"),
        },
        output: finalApprovalSummary,
      }],
    }, null, 2)}
`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 58,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.resumePlans[0].pr, 58);
    assert.equal(payload.resumePlans[0].runState, "failed");
    assert.equal(payload.resumePlans[0].artifactPath, resultPath);
    assert.equal(payload.resumePlans[0].resumeAction, "await_final_approval");
    assert.equal(payload.resumePlans[0].reportingIssue, "missing_output_artifact");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume falls back to deterministic output logs when grouped summaries are absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-output-log-fallback-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const resultPath = path.join(asyncResultsRoot, "run-output-log-58c.json");
    const finalApprovalSummary = [
      "Status: stopped at final human approval boundary",
      "Routed strategy: final_approval",
      "PR: https://github.com/owner/repo/pull/58",
      "Next recommended action: human reviews/approves PR #58",
    ].join("\n");

    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-output-log-58c",
      cwd: repoRoot,
      timestampMs: 1700000014650,
      exitCode: 1,
      outputText: finalApprovalSummary,
      writeOutputArtifact: false,
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-output-log-58c",
      state: "complete",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000014700,
      outputText: finalApprovalSummary,
    });
    await writeFile(resultPath, `${JSON.stringify({
      runId: "run-output-log-58c",
      agent: "dev-loop",
      state: "complete",
      cwd: repoRoot,
      results: [{
        agent: "dev-loop",
        artifactPaths: {
          output: path.join(asyncResultsRoot, "missing-run-output-log-58c_output.md"),
        },
      }],
    }, null, 2)}
`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 58,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.resumePlans[0].pr, 58);
    assert.equal(payload.resumePlans[0].artifactPath.endsWith("output-0.log"), true);
    assert.equal(payload.resumePlans[0].resumeAction, "await_final_approval");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed when an active matching run has the same timestamp as the exited candidate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-same-timestamp-active-run-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-complete-59",
      cwd: repoRoot,
      timestampMs: 1700000015000,
      outputText: "Active PR: owner/repo#59\nArtifact state: open\nLoop state: waiting_for_copilot_review\n",
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-active-59",
      state: "running",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000015000,
      outputText: "Active PR: owner/repo#59\nLoop state: waiting_for_copilot_review\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 59, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].pr, 59);
    assert.equal(payload.needsManualAttention[0].reason, "artifact_live_state_conflict");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume does not invent a failed run state from meta without an integer exitCode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-invalid-meta-exitcode-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const sessionRoot = path.join(sessionsRoot, "2026-06-03T00-00-00-000Z_session");
    const artifactsDir = path.join(sessionRoot, "subagent-artifacts");
    const runDir = path.join(sessionRoot, "run-meta-60", "run-0");
    const statusPath = path.join(asyncRunsRoot, "run-meta-60", "status.json");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "run-meta-60_dev-loop_0_meta.json"), `${JSON.stringify({ runId: "run-meta-60", agent: "dev-loop", timestamp: 1700000016000 }, null, 2)}
`, "utf8");
    await writeFile(path.join(artifactsDir, "run-meta-60_dev-loop_0_output.md"), "Active PR: owner/repo#60\nArtifact state: open\nLoop state: waiting_for_copilot_review\n", "utf8");
    await writeFile(path.join(runDir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "run-meta-60-session", timestamp: "2026-06-03T00:00:00.000Z", cwd: repoRoot })}\n`, "utf8");
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-meta-60",
      state: "complete",
      cwd: repoRoot,
      sessionPath: path.join(runDir, "session.jsonl"),
      timestampMs: 1700000016500,
      outputText: "Active PR: owner/repo#60\nLoop state: waiting_for_copilot_review\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 60, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].runState, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume keeps stale-worktree runs resumable when JSON result evidence is the only surviving artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-stale-worktree-result-json-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const staleWorktreePath = path.join(repoRoot, "tmp", "worktrees", "issue-61-stale");
    const resultPath = path.join(asyncResultsRoot, "run-result-61.json");
    await writeFile(resultPath, `${JSON.stringify({
      runId: "run-result-61",
      agent: "dev-loop",
      state: "complete",
      cwd: staleWorktreePath,
      summary: [
        "Run: run-result-61",
        "State: complete",
        "Agent: dev-loop",
        "Active PR: owner/repo#61",
        "Artifact state: open",
        "Loop state: waiting_for_copilot_review",
      ].join("\n"),
      results: [{
        agent: "dev-loop",
        output: [
          "Run: run-result-61",
          "State: complete",
          "Agent: dev-loop",
          "Active PR: owner/repo#61",
          "Artifact state: open",
          "Loop state: waiting_for_copilot_review",
        ].join("\n"),
      }],
    }, null, 2)}
`, "utf8");

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 61, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].pr, 61);
    assert.equal(payload.resumePlans[0].staleWorktree, true);
    assert.equal(payload.resumePlans[0].artifactPath, resultPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume includes a non-zero child index in the resume preview even when only one child matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-nonzero-child-index-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-child-62",
      childIndex: 1,
      cwd: repoRoot,
      timestampMs: 1700000017000,
      outputText: "Active PR: owner/repo#62\nArtifact state: open\nLoop state: unresolved_feedback_present\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 62,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.match(payload.resumePlans[0].resumeCommandPreview, /index: 1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume emits a feedback-fix resume plan for an orphaned unresolved-feedback PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-fix-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-fix-17",
      cwd: repoRoot,
      timestampMs: 1700000001000,
      outputText: [
        "Active PR: owner/repo#17",
        "Artifact state: open",
        "Loop state: unresolved_feedback_present",
        "Next action: address review feedback",
        "Handoff ownership: subagent",
        "Stop boundary: subagent_exit",
        "Resume policy: resume_after_subagent_exit",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 17,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });

    assert.equal(payload.autoResumeRequested, true);
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.orphanedPrCount, 1);
    assert.equal(payload.queueStatus, "attention_needed");

    const plan = payload.resumePlans[0];
    assert.equal(plan.pr, 17);
    assert.equal(plan.runId, "run-fix-17");
    assert.equal(plan.runState, "completed");
    assert.equal(plan.parsedArtifactState, "open");
    assert.equal(plan.parsedLoopState, "unresolved_feedback_present");
    assert.equal(plan.livePrState, "unresolved_feedback_present");
    assert.equal(plan.resumeAction, "needs_feedback_fix");
    assert.deepEqual(plan.handoffContract, {
      ownership: "subagent",
      stopBoundary: "subagent_exit",
      resumePolicy: "resume_after_subagent_exit",
    });
    assert.deepEqual(plan.recordedHandoffContract, {
      ownership: "subagent",
      stopBoundary: "subagent_exit",
      resumePolicy: "resume_after_subagent_exit",
    });
    assert.equal(
      plan.resumeMessage,
      "PR #17 is orphaned. Live state: unresolved_feedback_present. Resume the prior dev-loop from run run-fix-17. Continue by fixing the remaining review feedback, then reply to and resolve each GitHub thread. Do not merge.",
    );
    assert.equal(
      plan.resumeCommandPreview,
      'subagent({ action: "resume", id: "run-fix-17", message: "PR #17 is orphaned. Live state: unresolved_feedback_present. Resume the prior dev-loop from run run-fix-17. Continue by fixing the remaining review feedback, then reply to and resolve each GitHub thread. Do not merge." })',
    );
    assert.equal(plan.staleWorktree, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed when recorded handoff contract conflicts with resume action", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-handoff-mismatch-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-mismatch-17",
      cwd: repoRoot,
      timestampMs: 1700000001500,
      outputText: [
        "Active PR: owner/repo#17",
        "Artifact state: open",
        "Loop state: unresolved_feedback_present",
        "Next action: address review feedback",
        "Handoff ownership: human",
        "Stop boundary: approval_boundary",
        "Resume policy: resume_after_human_approval",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 17,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });

    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].reason, "handoff_contract_mismatch");
    assert.equal(payload.needsManualAttention[0].evidence.resumeAction, "needs_feedback_fix");
    assert.deepEqual(payload.needsManualAttention[0].evidence.recordedHandoffContract, {
      ownership: "human",
      stopBoundary: "approval_boundary",
      resumePolicy: "resume_after_human_approval",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume emits a final-approval resume plan for an orphaned approval-boundary PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-final-approval-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-final-22",
      cwd: repoRoot,
      timestampMs: 1700000002000,
      outputText: [
        "Status: stopped at final human approval boundary",
        "Routed strategy: final_approval",
        "PR: https://github.com/owner/repo/pull/22",
        "Next recommended action: human reviews/approves PR #22",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 22,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    const plan = payload.resumePlans[0];
    assert.equal(plan.pr, 22);
    assert.equal(plan.resumeAction, "await_final_approval");
    assert.equal(plan.livePrState, "final_approval_ready");
    assert.equal(
      plan.resumeMessage,
      "PR #22 is orphaned. Live state: final_approval_ready. Resume the prior dev-loop from run run-final-22. Continue by summarizing the clean current-head evidence and stop at final human approval. Do not merge without explicit authorization.",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume emits a merge-authorization resume plan for an orphaned merge-ready PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-merge-auth-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-merge-24",
      cwd: repoRoot,
      timestampMs: 1700000003000,
      outputText: [
        "Status: stopped at waiting_for_merge_authorization",
        "PR #24",
        "Next action: ask for explicit merge authorization",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 24,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    const plan = payload.resumePlans[0];
    assert.equal(plan.pr, 24);
    assert.equal(plan.resumeAction, "await_merge_authorization");
    assert.equal(plan.livePrState, "clean current-head gate evidence + green CI");
    assert.equal(
      plan.resumeMessage,
      "PR #24 is orphaned. Live state: clean current-head gate evidence + green CI. Resume the prior dev-loop from run run-merge-24. Continue by stopping at waiting_for_merge_authorization and asking for explicit merge authorization. Do not merge automatically.",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores an older completed run when a newer running run matches the same PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-suppressed-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-complete-30",
      cwd: repoRoot,
      timestampMs: 1700000001000,
      outputText: [
        "Active PR: owner/repo#30",
        "Artifact state: open",
        "Loop state: waiting_for_copilot_review",
      ].join("\n"),
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-active-30",
      state: "running",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000005000,
      outputText: "Active PR: owner/repo#30\nLoop state: waiting_for_copilot_review\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 30, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.orphanedPrCount, 0);
    assert.equal(payload.queueStatus, "monitoring");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed when the output artifact is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-missing-artifact-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const { sessionPath } = await writeSessionRun({
      sessionsRoot,
      runId: "run-missing-31",
      cwd: repoRoot,
      timestampMs: 1700000004000,
      outputText: "Active PR: owner/repo#31\n",
      writeOutputArtifact: false,
    });
    await writeAsyncRun({
      asyncRunsRoot,
      runId: "run-missing-31",
      state: "complete",
      cwd: repoRoot,
      sessionPath,
      timestampMs: 1700000004500,
      outputText: "Active PR: owner/repo#31\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 31,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].pr, 31);
    assert.equal(payload.needsManualAttention[0].runId, "run-missing-31");
    assert.equal(payload.needsManualAttention[0].reason, "unclassified_artifact_state");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume fails closed on ambiguous PR identity inside one artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-ambiguous-pr-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-ambiguous-33",
      cwd: repoRoot,
      timestampMs: 1700000005000,
      outputText: [
        "Active PR: owner/repo#33",
        "Status: still discussing PR #34",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 33 }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 1);
    assert.equal(payload.needsManualAttention[0].reason, "ambiguous_pr_identity");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume keeps a stale-worktree run resumable when artifact and session evidence are still present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-stale-worktree-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    const staleWorktreePath = path.join(repoRoot, "tmp", "worktrees", "issue-35-stale");
    await writeSessionRun({
      sessionsRoot,
      runId: "run-stale-35",
      cwd: staleWorktreePath,
      timestampMs: 1700000006000,
      outputText: [
        "Active PR: owner/repo#35",
        "Artifact state: open",
        "Loop state: unresolved_feedback_present",
      ].join("\n"),
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 35,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 1);
    assert.equal(payload.resumePlans[0].pr, 35);
    assert.equal(payload.resumePlans[0].staleWorktree, true);
    assert.equal(payload.manualAttentionCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume ignores non-dev-loop runs and runs from other repos", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-ignore-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-reviewer-36",
      agent: "reviewer",
      cwd: repoRoot,
      timestampMs: 1700000007000,
      outputText: "Active PR: owner/repo#36\n",
    });
    await writeSessionRun({
      sessionsRoot,
      runId: "run-other-repo-36",
      cwd: path.join(tempDir, "different-repo"),
      timestampMs: 1700000008000,
      outputText: "Active PR: owner/repo#36\n",
    });

    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{ number: 36, requestCopilot: true }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.orphanedPrCount, 0);
    assert.equal(payload.queueStatus, "monitoring");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume suppresses orphan alert for healthy PR (no unresolved threads, CI green) with fix/feedback artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-healthy-"));

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    // Exited run with artifact indicating unresolved feedback
    await writeSessionRun({
      sessionsRoot,
      runId: "run-healthy-40",
      cwd: repoRoot,
      timestampMs: 1700000001000,
      outputText: [
        "Active PR: owner/repo#40",
        "Artifact state: open",
        "Loop state: unresolved_feedback_present",
        "Next action: address review feedback",
      ].join("\n"),
    });

    // Healthy PR: CI green, no unresolved threads
    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 40,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        // No threadsPayload → defaults to empty (0 unresolved threads)
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });

    assert.equal(payload.autoResumeRequested, true);
    // Orphan detection suppressed — no resume plan for healthy PR
    assert.equal(payload.resumePlanCount, 0);
    assert.equal(payload.manualAttentionCount, 0);
    assert.equal(payload.orphanedPrCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor-monitor --auto-resume still flags orphan for unhealthy PR (unresolved threads present) with fix/feedback artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-orphan-unhealthy-"));
  const mixedThreadsFixture = await readFile(mixedThreadsFixturePath, "utf8");

  try {
    const { repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot } = await createAutoResumeRoots(tempDir);
    await writeSessionRun({
      sessionsRoot,
      runId: "run-unhealthy-41",
      cwd: repoRoot,
      timestampMs: 1700000001000,
      outputText: [
        "Active PR: owner/repo#41",
        "Artifact state: open",
        "Loop state: unresolved_feedback_present",
        "Next action: address review feedback",
        "Handoff ownership: subagent",
        "Stop boundary: subagent_exit",
        "Resume policy: resume_after_subagent_exit",
      ].join("\n"),
    });

    // Unhealthy PR: CI green but has unresolved threads
    const { runChild } = makeGhMock(buildGhEntries({
      prs: [{
        number: 41,
        reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        threadsPayload: mixedThreadsFixture,
      }],
    }));

    const payload = await runAutoResumeMonitor({ repoRoot, sessionsRoot, asyncRunsRoot, asyncResultsRoot, repo: "owner/repo", runChild });

    // Should still flag as orphan — PR has unresolved threads
    assert.equal(payload.orphanedPrCount, 1);
    assert.equal(payload.queueStatus, "attention_needed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("isPrHealthy treats crediblyGreen as healthy", () => {
  const healthy = isPrHealthy({
    snapshot: {
      unresolvedThreadCount: 0,
      ciStatus: "crediblyGreen",
    },
  });
  assert.equal(healthy, true);
});

test("isPrHealthy treats failure as unhealthy", () => {
  const healthy = isPrHealthy({
    snapshot: {
      unresolvedThreadCount: 0,
      ciStatus: "failure",
    },
  });
  assert.equal(healthy, false);
});

test("isPrHealthy treats unresolved threads as unhealthy with crediblyGreen CI", () => {
  const healthy = isPrHealthy({
    snapshot: {
      unresolvedThreadCount: 3,
      ciStatus: "crediblyGreen",
    },
  });
  assert.equal(healthy, false);
});
