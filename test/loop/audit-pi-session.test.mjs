import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  findLatestPiSession,
  collectTranscriptFiles,
  parseTranscriptFile,
  deriveSessionRole,
  auditPiSession,
  formatMarkdownSummary,
} from "../../scripts/lib/audit-pi-session.mjs";
import { runAuditCli } from "../../scripts/loop/audit-pi-session.mjs";

function createTempDir(prefix = "pi-audit-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function captureStream() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}

function writeSimpleTranscript(filePath) {
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "session_info", name: "subagent-review-unit-0" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "model-a",
          usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 },
        },
      }),
    ].join("\n") + "\n",
  );
}

describe("audit-pi-session unit & integration", () => {
  it("parses valid Pi assistant message usages from jsonl", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");

    const lines = [
      JSON.stringify({ type: "session_info", name: "subagent-review-unit-0" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: {
            input: 1000,
            output: 200,
            cacheRead: 5000,
            cacheWrite: 0,
            cost: { total: 0.05 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: {
            input: 500,
            output: 100,
            cacheRead: 6000,
            cacheWrite: 0,
            cost: { total: 0.03 },
          },
        },
      }),
    ];

    fs.writeFileSync(sessionFile, lines.join("\n") + "\n");

    const parsed = await parseTranscriptFile(sessionFile);
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0].model, "gemini-3.8-flash");
    assert.equal(parsed.turns[0].usage.input, 1000);
    assert.equal(parsed.turns[0].usage.cacheRead, 5000);
    assert.equal(parsed.turns[0].usage.cost, 0.05);
    assert.equal(parsed.sessionInfo.name, "subagent-review-unit-0");

    const role = deriveSessionRole(sessionFile, parsed);
    assert.equal(role, "review");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles empty files gracefully", async () => {
    const tmpDir = createTempDir();
    const emptyFile = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(emptyFile, "");

    const parsed = await parseTranscriptFile(emptyFile);
    assert.equal(parsed.turns.length, 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles missing files gracefully", () => {
    assert.throws(() => collectTranscriptFiles("/non/existent/path/xyz"), /Path does not exist/);
  });

  it("calculates context snowball metrics and cache hit ratios correctly", async () => {
    const tmpDir = createTempDir();
    const coordinatorFile = path.join(tmpDir, "coordinator.jsonl");

    // Turn 1: 1,000 prompt tokens (1,000 uncached, 0 cached)
    // Turn 2: 10,000 prompt tokens (2,000 uncached, 8,000 cached)
    // Turn 3: 30,000 prompt tokens (3,000 uncached, 27,000 cached)
    const lines = [
      JSON.stringify({
        type: "session_info",
        name: "subagent-dev-loop-run-0",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: { input: 2000, output: 100, cacheRead: 8000, cacheWrite: 0, cost: { total: 0.02 } },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: { input: 3000, output: 150, cacheRead: 27000, cacheWrite: 0, cost: { total: 0.03 } },
        },
      }),
    ];

    fs.writeFileSync(coordinatorFile, lines.join("\n") + "\n");

    const audit = await auditPiSession(coordinatorFile);
    assert.equal(audit.ok, true);
    assert.equal(audit.sessions.length, 1);

    const s = audit.sessions[0];
    assert.equal(s.role, "dev-loop");
    assert.equal(s.turnCount, 3);
    assert.equal(s.inputTokens, 6000);
    assert.equal(s.cacheReadTokens, 35000);
    assert.equal(s.outputTokens, 300);
    assert.equal(s.totalTokens, 41300);

    // Initial prompt = 1,000. Final prompt = 3,000 + 27,000 = 30,000. Growth = 30x.
    assert.equal(s.snowball.initialPromptTokens, 1000);
    assert.equal(s.snowball.finalPromptTokens, 30000);
    assert.equal(s.snowball.promptGrowthFactor, 30);

    // Cache hit ratio = 35,000 / (6,000 + 35,000) = 35000 / 41000 = ~0.8537
    assert.ok(Math.abs(s.snowball.cacheHitRatio - 0.8537) < 0.001);
    assert.ok(Math.abs(audit.summary.cacheHitRatio - 0.8537) < 0.001);
    assert.equal(audit.summary.estimatedCost, 0.06);

    const md = formatMarkdownSummary(audit);
    assert.ok(md.includes("Pi Session Token Audit"));
    assert.ok(md.includes("dev-loop"));
    assert.ok(md.includes("30x"));
    assert.ok(md.includes("Severe context growth"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores trailing zero-usage turns for snowball endpoints and turn counts", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 200, output: 20, cacheRead: 1800, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n",
    );

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.summary.totalTurns, 2);
    assert.equal(audit.sessions[0].turnCount, 2);
    assert.equal(audit.sessions[0].snowball.initialPromptTokens, 100);
    assert.equal(audit.sessions[0].snowball.finalPromptTokens, 2000);
    assert.equal(audit.sessions[0].snowball.promptGrowthFactor, 20);
    assert.match(formatMarkdownSummary(audit), /Severe context growth/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("traverses multi-subagent sessions correctly without mirrored artifacts", async () => {
    const tmpDir = createTempDir();
    const sessionDir = path.join(tmpDir, "session-root");
    const subagent1Dir = path.join(sessionDir, "run-dev-loop");
    const subagent2Dir = path.join(sessionDir, "run-reviewer");

    fs.mkdirSync(subagent1Dir, { recursive: true });
    fs.mkdirSync(subagent2Dir, { recursive: true });

    // Coordinator file
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session_info", name: "subagent-dev-loop-coord-0" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n"
    );

    // Subagent 1 file
    fs.writeFileSync(
      path.join(subagent1Dir, "session.jsonl"),
      [
        JSON.stringify({ type: "session_info", name: "subagent-fixer-fix-0" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-b",
            usage: { input: 200, output: 100, cacheRead: 500, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n"
    );

    // Subagent 2 file
    fs.writeFileSync(
      path.join(subagent2Dir, "session.jsonl"),
      [
        JSON.stringify({ type: "session_info", name: "subagent-review-rev-0" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 300, output: 150, cacheRead: 600, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n"
    );

    const artifactsDir = path.join(sessionDir, "subagent-artifacts");
    fs.mkdirSync(artifactsDir);
    fs.copyFileSync(
      path.join(sessionDir, "session.jsonl"),
      path.join(artifactsDir, "session.jsonl"),
    );

    const audit = await auditPiSession(sessionDir);
    assert.equal(audit.ok, true);
    assert.equal(audit.sessions.length, 3);
    assert.equal(audit.summary.totalTurns, 3);
    assert.equal(audit.summary.inputTokens, 600);
    assert.equal(audit.summary.outputTokens, 300);
    assert.equal(audit.summary.cacheReadTokens, 1100);

    assert.equal(audit.byModel["model-a"].turns, 2);
    assert.equal(audit.byModel["model-b"].turns, 1);
    assert.equal(audit.totalFilesExamined, 3);

    const roles = audit.sessions.map((s) => s.role).sort();
    assert.deepEqual(roles, ["dev-loop", "fixer", "review"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips fork snapshots when their parent transcript is present", async () => {
    const tmpDir = createTempDir();
    const runDir = path.join(tmpDir, "run-0");
    const forksDir = path.join(runDir, "session", "forks");
    fs.mkdirSync(forksDir, { recursive: true });
    const parentFile = path.join(runDir, "session.jsonl");
    writeSimpleTranscript(parentFile);

    const forkFile = path.join(forksDir, "fork.jsonl");
    fs.writeFileSync(
      forkFile,
      fs.readFileSync(parentFile, "utf8") +
        [
          JSON.stringify({ type: "session_info", name: "subagent-judge-unit-0" }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              model: "model-b",
              usage: { input: 500, output: 100, cacheRead: 500, cacheWrite: 0 },
            },
          }),
        ].join("\n") +
        "\n",
    );

    const parsedFork = await parseTranscriptFile(forkFile);
    assert.equal(parsedFork.sessionInfo.name, "subagent-review-unit-0");

    const audit = await auditPiSession(runDir);
    assert.equal(audit.skippedForkSnapshots, 1);
    assert.equal(audit.totalFilesExamined, 1);
    assert.equal(audit.activeSessionsCount, 1);
    assert.equal(audit.summary.totalTurns, 1);
    assert.equal(audit.summary.totalTokens, 350);
    assert.deepEqual(Object.keys(audit.byModel), ["model-a"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findLatestPiSession locates the latest canonical repository session", () => {
    const tmpDir = createTempDir();
    const fakeSessionsBase = path.join(tmpDir, "sessions");
    const repoSessions = path.join(fakeSessionsBase, "--Users-tester-dev-loops--");
    const worktreeSessions = path.join(
      fakeSessionsBase,
      "--Users-tester-dev-loops-tmp-worktrees-feature--",
    );
    fs.mkdirSync(repoSessions, { recursive: true });
    fs.mkdirSync(worktreeSessions, { recursive: true });

    const dir1 = path.join(repoSessions, "session-1");
    const dir2 = path.join(repoSessions, "session-2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    fs.writeFileSync(path.join(dir1, "session.jsonl"), "test1");
    // Ensure dir2 is modified later
    const futureTime = new Date(Date.now() + 10000);
    fs.writeFileSync(path.join(dir2, "session.jsonl"), "test2");
    fs.utimesSync(dir2, futureTime, futureTime);

    const worktreeDir = path.join(worktreeSessions, "newer-worktree-session");
    fs.mkdirSync(worktreeDir);
    const evenLater = new Date(Date.now() + 20000);
    fs.utimesSync(worktreeDir, evenLater, evenLater);

    const latest = findLatestPiSession(fakeSessionsBase);
    assert.equal(latest, dir2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("formats token counts deterministically with ASCII comma separators", () => {
    const result = {
      summary: {
        totalTurns: 1,
        totalTokens: 1234567,
        inputTokens: 1234567,
        cacheReadTokens: 0,
        outputTokens: 0,
        cacheHitRatio: 0,
        estimatedCost: 0,
      },
      byModel: {},
      sessions: [],
    };

    const markdown = formatMarkdownSummary(result);
    assert.match(markdown, /1,234,567/);
    assert.doesNotMatch(markdown, /1\.234\.567|1 234 567/);
  });

  it("covers JSON, jq, fields, silent, auto-discovery, and CLI errors", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const emptyFile = path.join(tmpDir, "empty.jsonl");
    const missingFile = path.join(tmpDir, "missing.jsonl");
    writeSimpleTranscript(sessionFile);
    fs.writeFileSync(emptyFile, "");

    let stdout = captureStream();
    let stderr = captureStream();
    assert.equal(await runAuditCli([sessionFile, "--json"], { stdout, stderr }), 0);
    assert.equal(JSON.parse(stdout.value).summary.totalTokens, 350);
    assert.equal(stderr.value, "");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli([sessionFile, "--jq", ".summary.totalTokens"], { stdout, stderr }),
      0,
    );
    assert.equal(stdout.value, "350\n");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli(["--json"], {
        stdout,
        stderr,
        findLatestSession: () => sessionFile,
      }),
      0,
    );
    assert.equal(JSON.parse(stdout.value).summary.totalTokens, 350);

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli([sessionFile, "--fields", "ok,totalFilesExamined"], { stdout, stderr }),
      0,
    );
    assert.equal(stdout.value, "true\t1\n");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(await runAuditCli([sessionFile, "--silent"], { stdout, stderr }), 0);
    assert.equal(stdout.value, "");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(await runAuditCli([sessionFile, "--jq", ".bad("], { stdout, stderr }), 2);
    assert.match(stderr.value, /BASE-JQ-OUTPUT-GUARANTEE/);

    for (const invalidPath of [missingFile, emptyFile]) {
      stdout = captureStream();
      stderr = captureStream();
      assert.equal(await runAuditCli([invalidPath], { stdout, stderr }), 1);
      assert.notEqual(stderr.value.trim(), "");
    }

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli([], {
        stdout,
        stderr,
        findLatestSession: () => {
          throw new Error("session tree unavailable");
        },
      }),
      1,
    );
    assert.match(stderr.value, /session tree unavailable/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
