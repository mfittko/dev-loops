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
      JSON.stringify({ type: "session", parentSession: null, timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "session_info", name: "subagent-review-unit-0", timestamp: "2026-01-01T00:00:00.100Z" }),
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

/**
 * Write a synthetic Claude Code transcript: one JSONL record per turn, shaped like a real
 * Claude assistant record (`type: "assistant"`, `message.usage` snake_case fields).
 */
function writeClaudeTranscript(filePath, turns) {
  const lines = turns.map((turn, index) => JSON.stringify({
    parentUuid: index === 0 ? null : `uuid-${index - 1}`,
    isSidechain: true,
    agentId: "agent-claude-test",
    type: "assistant",
    timestamp: turn.timestamp ?? `2026-01-01T00:00:0${index}.000Z`,
    requestId: turn.requestId,
    message: {
      model: turn.model ?? "claude-opus-5-5",
      id: turn.id ?? `msg_${index}`,
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: turn.usage,
    },
  }));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
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

  it("retains and aggregates a cost-only usage envelope", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "model-a",
          usage: { cost: { total: 0.125 } },
        },
      }) + "\n",
    );

    const parsed = await parseTranscriptFile(sessionFile);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].usage.cost, 0.125);

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.summary.totalTurns, 1);
    assert.equal(audit.summary.totalTokens, null);
    assert.equal(audit.summary.estimatedCost, 0.125);
    assert.equal(audit.byModel["model-a"].cost, 0.125);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves absent usage dimensions and rejects invalid measurements", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", parentSession: null }),
        JSON.stringify({ type: "session_info", name: "subagent-review-unit-0" }),
        '{"type":"message","message":{"role":"assistant","model":"model-a","usage":{"input":100,"output":-1,"cacheRead":null,"cacheWrite":[5],"reasoning":"abc","totalTokens":120,"cost":{"total":1e400}}}}',
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(sessionFile);
    assert.deepEqual(parsed.turns[0].usage, {
      input: 100,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      totalTokens: 120,
      cost: null,
    });

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.summary.totalTokens, 120);
    assert.equal(audit.summary.outputTokens, null);
    assert.equal(audit.summary.cacheReadTokens, null);
    assert.equal(audit.summary.cacheHitRatio, null);
    assert.equal(audit.summary.estimatedCost, null);
    const markdown = formatMarkdownSummary(audit);
    assert.match(markdown, /Cache Hit Ratio\*\*: n\/a/);
    assert.match(markdown, /Estimated Cost\*\*: n\/a/);
    assert.doesNotMatch(markdown, /Low cache hit ratio/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps known aggregate values and marks partially reported dimensions", async () => {
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
            usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, cost: 0.04 },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 50, output: 10, cacheRead: 150, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 25, output: 5, totalTokens: 30, cost: 0.01 },
          },
        }),
      ].join("\n") + "\n",
    );

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.summary.inputTokens, 175);
    assert.equal(audit.summary.cacheReadTokens, 450);
    assert.equal(audit.summary.totalTokens, 660);
    assert.equal(audit.summary.cacheHitRatio, 0.72);
    assert.equal(audit.summary.estimatedCost, 0.05);
    assert.equal(audit.summary.availability.inputTokens, "complete");
    assert.equal(audit.summary.availability.cacheReadTokens, "partial");
    assert.equal(audit.summary.availability.totalTokens, "complete");
    assert.equal(audit.summary.availability.cacheHitRatio, "partial");
    assert.equal(audit.summary.availability.estimatedCost, "partial");
    assert.equal(audit.sessions[0].availability.estimatedCost, "partial");
    assert.equal(audit.byModel["model-a"].availability.cacheReadTokens, "partial");
    assert.equal(audit.byModel["model-a"].availability.estimatedCost, "partial");
    assert.equal(Object.hasOwn(audit.byModel["model-a"].availability, "cacheRead"), false);
    assert.equal(Object.hasOwn(audit.byModel["model-a"].availability, "cost"), false);
    const markdown = formatMarkdownSummary(audit);
    assert.match(markdown, /Cached Read\*\*: 450 \(partial\)/);
    assert.match(markdown, /Cache Hit Ratio\*\*: 72\.0% \(partial\)/);
    assert.match(markdown, /Estimated Cost\*\*: \$0\.0500 \(partial\)/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aggregates prototype-shaped model names as ordinary model keys", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "__proto__",
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        },
      }) + "\n",
    );

    const audit = await auditPiSession(sessionFile);
    assert.equal(Object.hasOwn(audit.byModel, "__proto__"), true);
    assert.equal(audit.byModel.__proto__.turns, 1);
    assert.equal(audit.byModel.__proto__.totalTokens, 120);

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
          usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 25, cost: { total: 0.01 } },
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
    assert.equal(s.cacheWriteTokens, 25);
    assert.equal(s.totalTokens, 41325);

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
    assert.match(md, /Transcript Files Examined\*\*: 1/);
    assert.match(md, /\| Role \| Turns \| Models \| Total Tokens \| Cache Write \|/);
    assert.match(md, /\| 41,325 \| 25 \| 85\.4% \|/);

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

  it("reports prompt growth as unavailable when no initial prompt is measurable", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "model-a",
          usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      }) + "\n",
    );

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.sessions[0].snowball.initialPromptTokens, null);
    assert.equal(audit.sessions[0].snowball.promptGrowthFactor, null);
    assert.match(formatMarkdownSummary(audit), /\| n\/a \|$/m);
    assert.doesNotMatch(formatMarkdownSummary(audit), /Severe context growth/);

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

  it("derives a non-fallback role from a production-shaped session name", () => {
    const role = deriveSessionRole("/tmp/session.jsonl", {
      sessionInfo: {
        name: "subagent-coverage-76d71d14-7ff3-465f-a877-2729a80a4c87-1",
      },
      agent: null,
    });
    assert.equal(role, "coverage");
  });

  it("excludes a fork's inherited prefix and retains its own turns and role", async () => {
    const tmpDir = createTempDir();
    const runDir = path.join(tmpDir, "run-0");
    const forksDir = path.join(runDir, "session", "forks");
    fs.mkdirSync(forksDir, { recursive: true });
    const parentFile = path.join(runDir, "session.jsonl");
    writeSimpleTranscript(parentFile);

    const forkFile = path.join(forksDir, "fork.jsonl");
    const parentReplay = fs.readFileSync(parentFile, "utf8").trimEnd().split("\n").slice(1);
    fs.writeFileSync(
      forkFile,
      [
        JSON.stringify({
          type: "session",
          parentSession: "parent-session-id",
          timestamp: "2026-01-01T01:00:00.000Z",
        }),
        ...parentReplay,
        JSON.stringify({
          type: "session_info",
          name: "subagent-judge-unit-0",
          timestamp: "2026-01-01T01:00:00.100Z",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-b",
            usage: { input: 500, output: 100, cacheRead: 500, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n",
    );

    const parsedFork = await parseTranscriptFile(forkFile);
    assert.equal(parsedFork.isForkSnapshot, true);
    assert.equal(parsedFork.inheritedTurnCount, 1);
    assert.equal(parsedFork.sessionInfo.name, "subagent-judge-unit-0");
    assert.equal(parsedFork.turns.length, 1);
    assert.equal(parsedFork.turns[0].model, "model-b");

    const audit = await auditPiSession(runDir);
    assert.equal(Object.hasOwn(audit, "skippedForkSnapshots"), false);
    assert.equal(audit.forkSnapshotsProcessed, 1);
    assert.equal(audit.retainedForkTurns, 1);
    assert.equal(audit.skippedInheritedForkTurns, 1);
    assert.equal(audit.totalFilesExamined, 2);
    assert.equal(audit.activeSessionsCount, 2);
    assert.equal(audit.summary.totalTurns, 2);
    assert.equal(audit.summary.totalTokens, 1450);
    assert.equal(audit.byModel["model-a"].turns, 1);
    assert.equal(audit.byModel["model-b"].turns, 1);
    assert.equal(audit.sessions.find((session) => session.role === "judge")?.turnCount, 1);
    assert.match(formatMarkdownSummary(audit), /1 fork-own turns retained; 1 inherited turns excluded/);

    const directParentAudit = await auditPiSession(parentFile);
    assert.equal(directParentAudit.totalFilesExamined, 1);
    assert.equal(directParentAudit.forkSnapshotsProcessed, 0);
    assert.equal(directParentAudit.summary.totalTurns, 1);

    const directForkAudit = await auditPiSession(forkFile);
    assert.equal(directForkAudit.totalFilesExamined, 1);
    assert.equal(directForkAudit.forkSnapshotsProcessed, 1);
    assert.equal(directForkAudit.retainedForkTurns, 1);
    assert.equal(directForkAudit.skippedInheritedForkTurns, 1);
    assert.equal(directForkAudit.summary.totalTurns, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes a multi-segment parent replay using the fork timestamp boundary", async () => {
    const tmpDir = createTempDir();
    const forkFile = path.join(tmpDir, "fork.jsonl");
    fs.writeFileSync(
      forkFile,
      [
        JSON.stringify({ type: "session", parentSession: "/tmp/parent.jsonl", timestamp: "2026-01-02T00:00:00.000Z" }),
        JSON.stringify({ type: "session_info", name: "subagent-review-parent-0", timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-dev-loop-parent-0", timestamp: "2026-01-01T12:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-coverage-76d71d14-7ff3-465f-a877-2729a80a4c87-1", timestamp: "2026-01-02T00:00:00.500Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-b", usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 } } }),
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(forkFile);
    assert.equal(parsed.isForkSnapshot, true);
    assert.equal(parsed.inheritedTurnCount, 2);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].agent, "subagent-coverage-76d71d14-7ff3-465f-a877-2729a80a4c87-1");

    const audit = await auditPiSession(forkFile);
    assert.equal(audit.summary.totalTurns, 1);
    assert.equal(audit.summary.totalTokens, 330);
    assert.equal(audit.retainedForkTurns, 1);
    assert.equal(audit.skippedInheritedForkTurns, 2);
    assert.deepEqual(audit.sessions.map((session) => session.role), ["coverage"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes a fork replay with no session_info before the fork's own segment", async () => {
    const tmpDir = createTempDir();
    const forkFile = path.join(tmpDir, "fork.jsonl");
    fs.writeFileSync(
      forkFile,
      [
        JSON.stringify({ type: "session", parentSession: "/tmp/parent.jsonl", timestamp: "2026-01-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", agent: "parent", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "message", agent: "parent", message: { role: "assistant", model: "model-a", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-judge-fork-0", timestamp: "2026-01-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-b", usage: { input: 400, output: 40, cacheRead: 0, cacheWrite: 0 } } }),
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(forkFile);
    assert.equal(parsed.isForkSnapshot, true);
    assert.equal(parsed.inheritedTurnCount, 2);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].agent, "subagent-judge-fork-0");

    const audit = await auditPiSession(forkFile);
    assert.equal(audit.summary.totalTurns, 1);
    assert.equal(audit.summary.totalTokens, 440);
    assert.equal(audit.retainedForkTurns, 1);
    assert.equal(audit.skippedInheritedForkTurns, 2);
    assert.deepEqual(audit.sessions.map((session) => session.role), ["judge"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a fork whose timestamp boundary cannot be resolved", async () => {
    const tmpDir = createTempDir();
    const forkFile = path.join(tmpDir, "fork.jsonl");
    fs.writeFileSync(
      forkFile,
      [
        JSON.stringify({ type: "session", parentSession: "/tmp/parent.jsonl" }),
        JSON.stringify({ type: "session_info", name: "subagent-review-parent-0", timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-judge-fork-0", timestamp: "2026-01-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-b", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 } } }),
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(forkFile);
    assert.equal(parsed.isForkSnapshot, true);
    assert.equal(parsed.unresolvedForkBoundary, true);
    assert.equal(parsed.inheritedTurnCount, 0);
    assert.equal(parsed.turns.length, 2);

    const audit = await auditPiSession(forkFile);
    assert.equal(audit.unresolvedForkBoundaries, 1);
    assert.equal(audit.summary.unresolvedForkBoundaries, 1);
    assert.match(formatMarkdownSummary(audit), /Unresolved Fork Boundaries\*\*: 1;.*totals may be incomplete/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not classify falsy non-string parentSession values as forks", async () => {
    const tmpDir = createTempDir();
    for (const [index, parentSession] of ["", 0, false].entries()) {
      const sessionFile = path.join(tmpDir, `session-${index}.jsonl`);
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session", parentSession, timestamp: "2026-01-02T00:00:00.000Z" }),
          JSON.stringify({ type: "session_info", name: "subagent-review-unit-0", timestamp: "2026-01-02T00:00:00.100Z" }),
          JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        ].join("\n") + "\n",
      );
      const parsed = await parseTranscriptFile(sessionFile);
      assert.equal(parsed.isForkSnapshot, false);
      assert.equal(parsed.turns.length, 1);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retains every segment in a non-fork transcript with multiple session_info records", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", parentSession: null }),
        JSON.stringify({ type: "session_info", name: "subagent-review-first-0" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-fixer-second-0" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-b", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "session_info", name: "subagent-judge-third-0" }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-c", usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 } } }),
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(sessionFile);
    assert.equal(parsed.isForkSnapshot, false);
    assert.equal(parsed.inheritedTurnCount, 0);
    assert.equal(parsed.turns.length, 3);
    assert.deepEqual(parsed.turns.map((turn) => turn.agent), [
      "subagent-review-first-0",
      "subagent-fixer-second-0",
      "subagent-judge-third-0",
    ]);

    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.summary.totalTurns, 3);
    assert.equal(audit.summary.totalTokens, 660);
    assert.equal(audit.activeSessionsCount, 3);
    assert.equal(audit.forkSnapshotsProcessed, 0);
    assert.equal(audit.retainedForkTurns, 0);
    assert.equal(audit.skippedInheritedForkTurns, 0);
    assert.deepEqual(audit.sessions.map((session) => session.role), ["review", "fixer", "judge"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes a coordinator transcript beside its matching session directory", async () => {
    const tmpDir = createTempDir();
    const sessionDir = path.join(tmpDir, "session-id");
    fs.mkdirSync(path.join(sessionDir, "run-0"), { recursive: true });
    fs.writeFileSync(
      `${sessionDir}.jsonl`,
      [
        JSON.stringify({ type: "session_info", name: "subagent-dev-loop-unit-0" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n") + "\n",
    );
    writeSimpleTranscript(path.join(sessionDir, "run-0", "session.jsonl"));

    const audit = await auditPiSession(sessionDir);
    assert.equal(audit.totalFilesExamined, 2);
    assert.equal(audit.activeSessionsCount, 2);
    assert.equal(audit.sessions.some((session) => session.role === "dev-loop"), true);

    const coordinatorFileAudit = await auditPiSession(`${sessionDir}.jsonl`);
    assert.equal(coordinatorFileAudit.totalFilesExamined, 2);
    assert.equal(coordinatorFileAudit.activeSessionsCount, 2);
    assert.deepEqual(
      coordinatorFileAudit.sessions.map((session) => session.role).sort(),
      ["dev-loop", "review"],
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findLatestPiSession returns null when the sessions base does not exist", () => {
    const tmpDir = createTempDir();
    const repoCwd = path.join(tmpDir, "repo");
    assert.equal(findLatestPiSession(path.join(tmpDir, "absent"), repoCwd), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findLatestPiSession scopes discovery to this repository and includes worktrees", () => {
    const tmpDir = createTempDir();
    const fakeSessionsBase = path.join(tmpDir, "sessions");
    const repoSessions = path.join(fakeSessionsBase, "--Users-tester-dev-loops--");
    const worktreeSessions = path.join(fakeSessionsBase, "--Users-tester-dev-loops-tmp-worktrees-feature--");
    const otherRepoSessions = path.join(fakeSessionsBase, "--Users-tester-pi-dev-loops--");
    fs.mkdirSync(repoSessions, { recursive: true });
    fs.mkdirSync(worktreeSessions, { recursive: true });
    fs.mkdirSync(otherRepoSessions, { recursive: true });

    const repoDir = path.join(repoSessions, "repo-session");
    const worktreeDir = path.join(worktreeSessions, "worktree-session");
    const otherRepoDir = path.join(otherRepoSessions, "wrong-repo-session");
    const artifactsDir = path.join(repoSessions, "subagent-artifacts");
    fs.mkdirSync(repoDir);
    fs.mkdirSync(worktreeDir);
    fs.mkdirSync(otherRepoDir);
    fs.mkdirSync(artifactsDir);
    const repoTranscript = path.join(repoDir, "session.jsonl");
    const worktreeTranscript = path.join(worktreeDir, "session.jsonl");
    fs.writeFileSync(repoTranscript, "repo");
    fs.writeFileSync(worktreeTranscript, "worktree");

    // Directory metadata points at repoDir, but the active worktree transcript is newer.
    fs.utimesSync(repoDir, new Date("2026-01-04T00:00:00Z"), new Date("2026-01-04T00:00:00Z"));
    fs.utimesSync(worktreeDir, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    fs.utimesSync(repoTranscript, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    fs.utimesSync(worktreeTranscript, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));

    const latest = findLatestPiSession(fakeSessionsBase, "/Users/tester/dev-loops");
    assert.equal(latest, worktreeDir);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findLatestPiSession handles bare transcripts and prefers a matching session directory", () => {
    const tmpDir = createTempDir();
    const fakeSessionsBase = path.join(tmpDir, "sessions");
    const repoSessions = path.join(fakeSessionsBase, "--Users-tester-dev-loops--");
    fs.mkdirSync(repoSessions, { recursive: true });

    const bareFile = path.join(repoSessions, "bare-session.jsonl");
    fs.writeFileSync(bareFile, "bare");
    assert.equal(findLatestPiSession(fakeSessionsBase, "/Users/tester/dev-loops"), bareFile);

    const pairedFile = path.join(repoSessions, "paired-session.jsonl");
    const pairedDir = path.join(repoSessions, "paired-session");
    fs.writeFileSync(pairedFile, "paired");
    fs.mkdirSync(pairedDir);
    const newer = new Date(Date.now() + 20000);
    fs.utimesSync(pairedFile, newer, newer);
    assert.equal(findLatestPiSession(fakeSessionsBase, "/Users/tester/dev-loops"), pairedDir);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counts malformed transcript lines and warns that totals may be incomplete", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const validFile = path.join(tmpDir, "valid.jsonl");
    writeSimpleTranscript(validFile);
    fs.writeFileSync(sessionFile, `${fs.readFileSync(validFile, "utf8")}{\"type\":\"message\"\n`);

    const parsed = await parseTranscriptFile(sessionFile);
    assert.equal(parsed.malformedLineCount, 1);
    const audit = await auditPiSession(sessionFile);
    assert.equal(audit.malformedLines, 1);
    assert.equal(audit.summary.malformedLines, 1);
    assert.match(formatMarkdownSummary(audit), /Malformed Lines\*\*: 1 skipped/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("escapes transcript-controlled role and model values in Markdown", () => {
    const unsafe = "name|injected\n`code` <img src=x> [text](url)\u0000\u0009\u001b\u007f";
    const result = {
      targetPath: "/tmp/session",
      summary: {
        totalTurns: 1,
        totalTokens: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        outputTokens: 0,
        cacheHitRatio: 0,
        estimatedCost: 0,
        malformedLines: 0,
      },
      byModel: {
        [unsafe]: { turns: 1, input: 1, cacheRead: 0, output: 0, cacheHitRatio: 0, totalTokens: 1, cost: 0 },
      },
      sessions: [{
        role: unsafe,
        models: [unsafe],
        turnCount: 101,
        totalTokens: 1,
        snowball: { cacheHitRatio: 0, initialPromptTokens: 1, finalPromptTokens: 1, promptGrowthFactor: 1 },
      }],
    };

    const markdown = formatMarkdownSummary(result);
    assert.doesNotMatch(markdown, /name\|injected\n/);
    assert.match(markdown, /name\\\|injected<br>&#96;code&#96; &lt;img src=x&gt; &#91;text&#93;&#40;url&#41;/);
    assert.doesNotMatch(markdown, /<img src=x>|\[text\]\(url\)/);
    assert.doesNotMatch(markdown, /\u0000|\u0009|\u001b|\u007f/);
    assert.match(markdown, /&#0;&#9;&#27;&#127;/);
    assert.match(markdown, /High turn count/);
  });

  it("emits high-turn and low-cache warnings only beyond their thresholds", () => {
    const base = {
      targetPath: "/tmp/session",
      summary: { totalTurns: 1, totalTokens: 1, inputTokens: 1, cacheReadTokens: 0, outputTokens: 0, cacheHitRatio: 0, estimatedCost: 0, malformedLines: 0 },
      byModel: {},
    };
    const makeSession = (role, turnCount, totalTokens, cacheHitRatio) => ({
      role,
      models: [],
      turnCount,
      totalTokens,
      snowball: { cacheHitRatio, initialPromptTokens: 1, finalPromptTokens: 1, promptGrowthFactor: 1 },
    });

    const positive = formatMarkdownSummary({
      ...base,
      sessions: [
        makeSession("high-turn", 101, 100, 0.9),
        makeSession("low-cache", 10, 500_000, 0.69),
      ],
    });
    assert.match(positive, /High turn count/);
    assert.match(positive, /Low cache hit ratio/);

    const negative = formatMarkdownSummary({
      ...base,
      sessions: [
        makeSession("turn-boundary", 100, 100, 0.9),
        makeSession("cache-boundary", 10, 500_000, 0.70),
        makeSession("token-boundary", 10, 499_999, 0.69),
      ],
    });
    assert.doesNotMatch(negative, /High turn count|Low cache hit ratio/);
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

  it("covers structured output, explicit latest, and CLI errors", async () => {
    const tmpDir = createTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const emptyFile = path.join(tmpDir, "empty.jsonl");
    const emptyDir = path.join(tmpDir, "empty-dir");
    const missingFile = path.join(tmpDir, "missing.jsonl");
    writeSimpleTranscript(sessionFile);
    fs.writeFileSync(emptyFile, "");
    fs.mkdirSync(emptyDir);

    let stdout = captureStream();
    let stderr = captureStream();
    assert.equal(await runAuditCli(["--help"], { stdout, stderr }), 0);
    assert.match(stdout.value, /Usage:/);
    assert.match(stdout.value, /A single transcript file is audited\s+alone\./);
    assert.equal(stderr.value, "");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli([], { stdout, stderr, findLatestSession: () => null }),
      1,
    );
    assert.equal(stdout.value, "");
    assert.match(stderr.value, /Could not automatically locate latest Pi session directory/);

    stdout = captureStream();
    stderr = captureStream();
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
        cwd: tmpDir,
        findLatestSession: (sessionsBaseDir, repositoryCwd) => {
          assert.equal(sessionsBaseDir, undefined);
          assert.equal(repositoryCwd, tmpDir);
          return sessionFile;
        },
      }),
      0,
    );
    assert.equal(JSON.parse(stdout.value).summary.totalTokens, 350);

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(
      await runAuditCli(["--latest", "--json"], {
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
    assert.equal(await runAuditCli([emptyDir], { stdout, stderr }), 1);
    assert.match(stderr.value, /No \.jsonl transcripts found/);

    stdout = captureStream();
    stderr = captureStream();
    let latestLookupCalled = false;
    assert.equal(
      await runAuditCli([sessionFile, "--latest"], {
        stdout,
        stderr,
        findLatestSession: () => {
          latestLookupCalled = true;
          return sessionFile;
        },
      }),
      2,
    );
    assert.equal(latestLookupCalled, false);
    assert.match(stderr.value, /either an explicit session path or --latest/);

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(await runAuditCli([sessionFile, emptyFile], { stdout, stderr }), 2);
    assert.match(stderr.value, /at most one session path/);

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

  it("computes Claude Code summary fields and snowball metrics, raising the same anti-pattern flags as the Pi equivalent", async () => {
    const tmpDir = createTempDir();

    // Same prompt progression as the Pi snowball test: 1,000 -> 10,000 -> 30,000 prompt
    // tokens (30x growth), 35,000 cached read of 41,000 total prompt tokens (~85.4% hit).
    const claudeFile = path.join(tmpDir, "agent-claude-1.jsonl");
    writeClaudeTranscript(claudeFile, [
      { id: "msg_1", usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "msg_2", usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 } },
      { id: "msg_3", usage: { input_tokens: 3000, output_tokens: 150, cache_read_input_tokens: 27000, cache_creation_input_tokens: 0 } },
    ]);

    const audit = await auditPiSession(claudeFile);
    assert.equal(audit.ok, true);
    assert.equal(audit.harness, "claude");
    assert.equal(audit.sessions.length, 1);

    const s = audit.sessions[0];
    assert.equal(s.turnCount, 3);
    assert.equal(s.inputTokens, 6000);
    assert.equal(s.cacheReadTokens, 35000);
    assert.equal(s.outputTokens, 300);
    assert.equal(s.snowball.initialPromptTokens, 1000);
    assert.equal(s.snowball.finalPromptTokens, 30000);
    assert.equal(s.snowball.promptGrowthFactor, 30);
    assert.ok(Math.abs(s.snowball.cacheHitRatio - 0.8537) < 0.001);
    assert.equal(audit.summary.totalTurns, 3);
    assert.ok(Math.abs(audit.summary.cacheHitRatio - 0.8537) < 0.001);

    const claudeMd = formatMarkdownSummary(audit);
    assert.ok(claudeMd.includes("Claude Code Session Token Audit"));
    assert.ok(claudeMd.includes("30x"));
    assert.match(claudeMd, /Severe context growth/);

    // The Pi extractor produces the identical shape and raises the identical warning
    // for the same numbers, via the same shared metric/threshold logic.
    const piFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      piFile,
      [
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 2000, output: 100, cacheRead: 8000, cacheWrite: 0 } } }),
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 3000, output: 150, cacheRead: 27000, cacheWrite: 0 } } }),
      ].join("\n") + "\n",
    );
    const piAudit = await auditPiSession(piFile);
    assert.equal(piAudit.harness, "pi");
    assert.equal(piAudit.sessions[0].snowball.promptGrowthFactor, 30);
    const piMd = formatMarkdownSummary(piAudit);
    assert.ok(piMd.includes("Pi Session Token Audit"));
    assert.ok(piMd.includes("30x"));
    assert.match(piMd, /Severe context growth/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-detects harness from record schema per file with no flag, and reports mixed for a directory with both", async () => {
    const tmpDir = createTempDir();
    const piFile = path.join(tmpDir, "session.jsonl");
    writeSimpleTranscript(piFile);

    const piOnly = await auditPiSession(piFile);
    assert.equal(piOnly.harness, "pi");

    const claudeDir = path.join(tmpDir, "claude-only");
    fs.mkdirSync(claudeDir);
    const claudeFile = path.join(claudeDir, "agent-claude-2.jsonl");
    writeClaudeTranscript(claudeFile, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
    const claudeOnly = await auditPiSession(claudeFile);
    assert.equal(claudeOnly.harness, "claude");

    const mixedDir = path.join(tmpDir, "mixed");
    fs.mkdirSync(mixedDir);
    fs.copyFileSync(piFile, path.join(mixedDir, "session.jsonl"));
    fs.copyFileSync(claudeFile, path.join(mixedDir, "agent-claude-2.jsonl"));
    const mixed = await auditPiSession(mixedDir);
    assert.equal(mixed.harness, "mixed");
    assert.equal(mixed.totalFilesExamined, 2);
    assert.match(formatMarkdownSummary(mixed), /## Session Token Audit/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--harness override forces the extractor regardless of the detected record schema", async () => {
    const tmpDir = createTempDir();
    const piFile = path.join(tmpDir, "session.jsonl");
    writeSimpleTranscript(piFile);

    const autoParsed = await parseTranscriptFile(piFile);
    assert.equal(autoParsed.harness, "pi");
    assert.equal(autoParsed.turns[0].usage.input, 100);

    const forcedClaude = await parseTranscriptFile(piFile, { harness: "claude" });
    assert.equal(forcedClaude.harness, "claude");
    // Pi's camelCase usage fields don't exist on Claude's snake_case shape, so a forced
    // Claude extraction on Pi data yields nulls: the override genuinely changed extraction.
    assert.equal(forcedClaude.turns[0].usage.input, null);
    assert.equal(forcedClaude.turns[0].promptTokens, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dedupes streaming Claude records sharing one message.id, keeping the last record's usage", async () => {
    const tmpDir = createTempDir();
    const claudeFile = path.join(tmpDir, "agent-claude-3.jsonl");
    const growingUsage = (outputTokens) => ({
      input_tokens: 2,
      cache_creation_input_tokens: 15613,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens,
    });
    writeClaudeTranscript(claudeFile, [
      { id: "msg_stream-1", usage: growingUsage(1) },
      { id: "msg_stream-1", usage: growingUsage(4) },
      { id: "msg_stream-1", usage: growingUsage(8) },
    ]);

    const parsed = await parseTranscriptFile(claudeFile);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].usage.output, 8);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a Claude .output symlink to its transcript and reads role/sessionName from the sibling meta.json", async () => {
    const tmpDir = createTempDir();
    const agentsDir = path.join(tmpDir, "agents");
    const tasksDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });

    const transcriptFile = path.join(agentsDir, "agent-abc123.jsonl");
    writeClaudeTranscript(transcriptFile, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
    fs.writeFileSync(
      path.join(agentsDir, "agent-abc123.meta.json"),
      JSON.stringify({ agentType: "fixer", description: "Fix draft_gate r1 act list", parentAgentId: "parent-1" }),
    );
    fs.symlinkSync(transcriptFile, path.join(tasksDir, "task-1.output"));

    const audit = await auditPiSession(tasksDir);
    assert.equal(audit.totalFilesExamined, 1);
    assert.equal(audit.sessions.length, 1);
    assert.equal(audit.sessions[0].role, "fixer");
    assert.equal(audit.sessions[0].sessionName, "Fix draft_gate r1 act list");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores a plain-text .output file (not a transcript) rather than treating it as malformed", () => {
    const tmpDir = createTempDir();
    const tasksDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "bg-task.output"), "Task completed successfully\nExit code: 0\n");

    assert.deepEqual(collectTranscriptFiles(tasksDir), []);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--harness rejects an invalid value with exit code 2", async () => {
    const tmpDir = createTempDir();
    const claudeFile = path.join(tmpDir, "agent-claude-4.jsonl");
    writeClaudeTranscript(claudeFile, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    let stdout = captureStream();
    let stderr = captureStream();
    assert.equal(await runAuditCli([claudeFile, "--harness", "bogus"], { stdout, stderr }), 2);
    assert.match(stderr.value, /--harness/);
    assert.equal(stdout.value, "");

    stdout = captureStream();
    stderr = captureStream();
    assert.equal(await runAuditCli([claudeFile, "--harness", "claude", "--json"], { stdout, stderr }), 0);
    assert.equal(JSON.parse(stdout.value).harness, "claude");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shares one audit entrypoint and one threshold set across harnesses (no duplicated metric/threshold logic)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/lib/audit-pi-session.mjs"),
      "utf8",
    );
    // Claude support extends the one audit entrypoint rather than forking a parallel path.
    assert.equal((source.match(/^export (async )?function audit\w*Session/gm) || []).length, 1);
    // Anti-pattern thresholds are defined once and shared by both harnesses.
    for (const threshold of ["> 100", "> 15", "< 0.70"]) {
      const occurrences = source.split(threshold).length - 1;
      assert.equal(occurrences, 1, `threshold ${threshold} should appear exactly once (shared, not duplicated)`);
    }
  });

  it("dedupes interleaved Claude message.id turns by first appearance, keeping each id's last usage", async () => {
    const tmpDir = createTempDir();
    const claudeFile = path.join(tmpDir, "agent-claude-interleaved.jsonl");
    writeClaudeTranscript(claudeFile, [
      { id: "msg_A", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "msg_B", usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "msg_A", usage: { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    const parsed = await parseTranscriptFile(claudeFile);
    // Not 3: an interleaved repeat of "msg_A" overwrites its first-appearance slot rather
    // than being appended as a second turn.
    assert.equal(parsed.turns.length, 2);
    assert.deepEqual(parsed.turns.map((turn) => turn.usage.output), [9, 2]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dedupes a Claude turn replayed with the same message.id + requestId across two files, first file wins", async () => {
    const tmpDir = createTempDir();
    const sessionDir = path.join(tmpDir, "session-root");
    fs.mkdirSync(sessionDir, { recursive: true });

    const firstFile = path.join(sessionDir, "agent-claude-a.jsonl");
    const secondFile = path.join(sessionDir, "agent-claude-b.jsonl");
    writeClaudeTranscript(firstFile, [
      { id: "msg_shared", requestId: "req_shared", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
    // A resumed session replays the same turn (identical id + requestId) plus one new turn.
    writeClaudeTranscript(secondFile, [
      { id: "msg_shared", requestId: "req_shared", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "msg_new", requestId: "req_new", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    const audit = await auditPiSession(sessionDir);
    assert.equal(audit.summary.totalTurns, 2);
    assert.equal(audit.summary.inputTokens, 13);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores a .output file whose first line is JSON but not transcript-shaped (a bare value or object)", () => {
    const tmpDir = createTempDir();
    const tasksDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "status.output"), '{"ok":true}\nExit code: 0\n');
    fs.writeFileSync(path.join(tasksDir, "code.output"), "42\nDone\n");
    fs.writeFileSync(path.join(tasksDir, "null.output"), "null\nDone\n");

    assert.deepEqual(collectTranscriptFiles(tasksDir), []);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a single file's harness as mixed when it contains both Pi- and Claude-shaped usage envelopes, preserving record order", async () => {
    const tmpDir = createTempDir();
    const mixedFile = path.join(tmpDir, "mixed-session.jsonl");
    fs.writeFileSync(
      mixedFile,
      [
        JSON.stringify({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", id: "msg_1", usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
      ].join("\n") + "\n",
    );

    const parsed = await parseTranscriptFile(mixedFile);
    assert.equal(parsed.harness, "mixed");
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0].usage.input, 100);
    assert.equal(parsed.turns[1].usage.input, 50);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hints at the detected harness and --harness auto when a forced --harness mode finds zero usage turns", async () => {
    const tmpDir = createTempDir();
    const claudeFile = path.join(tmpDir, "agent-claude-forced.jsonl");
    writeClaudeTranscript(claudeFile, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    await assert.rejects(
      () => auditPiSession(claudeFile, { harness: "pi" }),
      /No assistant turns with token usage found in .*\(detected claude-shaped usage envelopes; try --harness auto\)/,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies a Claude agent-<id>.jsonl transcript without a meta sidecar as subagent", async () => {
    const tmpDir = createTempDir();
    const claudeFile = path.join(tmpDir, "agent-nometa123.jsonl");
    writeClaudeTranscript(claudeFile, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    const audit = await auditPiSession(claudeFile);
    assert.equal(audit.sessions[0].role, "subagent");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mentions .output files too in the no-transcripts error", async () => {
    const tmpDir = createTempDir();
    const emptyDir = path.join(tmpDir, "empty-dir");
    fs.mkdirSync(emptyDir);

    const stdout = captureStream();
    const stderr = captureStream();
    assert.equal(await runAuditCli([emptyDir], { stdout, stderr }), 1);
    assert.match(stderr.value, /No \.jsonl transcripts found/);
    assert.match(stderr.value, /\.output/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
