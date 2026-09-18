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

function createTempDir(prefix = "pi-audit-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    assert.equal(parsed.empty, false);
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
    assert.equal(parsed.empty, true);
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

  it("traverses multi-subagent sessions correctly", async () => {
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

    const audit = await auditPiSession(sessionDir);
    assert.equal(audit.ok, true);
    assert.equal(audit.sessions.length, 3);
    assert.equal(audit.summary.totalTurns, 3);
    assert.equal(audit.summary.inputTokens, 600);
    assert.equal(audit.summary.outputTokens, 300);
    assert.equal(audit.summary.cacheReadTokens, 1100);

    assert.equal(audit.byModel["model-a"].turns, 2);
    assert.equal(audit.byModel["model-b"].turns, 1);

    const roles = audit.sessions.map((s) => s.role).sort();
    assert.deepEqual(roles, ["dev-loop", "fixer", "review"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findLatestPiSession locates latest modified directory", () => {
    const tmpDir = createTempDir();
    const fakeSessionsBase = path.join(tmpDir, "sessions");
    const repoSessions = path.join(fakeSessionsBase, "--Users-tester-dev-loops--");
    fs.mkdirSync(repoSessions, { recursive: true });

    const dir1 = path.join(repoSessions, "session-1");
    const dir2 = path.join(repoSessions, "session-2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    fs.writeFileSync(path.join(dir1, "session.jsonl"), "test1");
    // Ensure dir2 is modified later
    const futureTime = new Date(Date.now() + 10000);
    fs.writeFileSync(path.join(dir2, "session.jsonl"), "test2");
    fs.utimesSync(dir2, futureTime, futureTime);

    const latest = findLatestPiSession(fakeSessionsBase);
    assert.equal(latest, dir2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
