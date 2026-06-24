import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CLAUDE_BIN,
  buildDevLoopPrompt,
  buildHeadlessClaudeInvocation,
} from "../src/claude/headless-entry.mjs";

test("buildDevLoopPrompt targets issue, pr, or current state", () => {
  assert.match(buildDevLoopPrompt({ issue: 775 }), /issue #775/);
  assert.match(buildDevLoopPrompt({ pr: 42 }), /PR #42/);
  assert.match(buildDevLoopPrompt({}), /current state/);
  assert.match(buildDevLoopPrompt({ issue: 1 }), /\/dev-loop skill/);
});

test("buildHeadlessClaudeInvocation builds `claude -p <prompt>` and propagates DEVLOOPS_RUN_ID", () => {
  const { command, args, env } = buildHeadlessClaudeInvocation({
    prompt: "do the loop",
    runId: "devloops-abc",
    baseEnv: { EXISTING: "1" },
  });
  assert.equal(command, DEFAULT_CLAUDE_BIN);
  assert.deepEqual(args, ["-p", "do the loop"]);
  assert.equal(env.DEVLOOPS_RUN_ID, "devloops-abc");
  assert.equal(env.EXISTING, "1", "base env is preserved");
});

test("buildHeadlessClaudeInvocation honors claudeBin and extraArgs", () => {
  const { command, args } = buildHeadlessClaudeInvocation({
    prompt: "p",
    runId: "r",
    claudeBin: "/opt/claude",
    extraArgs: ["--output-format", "json"],
  });
  assert.equal(command, "/opt/claude");
  assert.deepEqual(args, ["-p", "p", "--output-format", "json"]);
});

test("buildHeadlessClaudeInvocation rejects empty prompt or runId", () => {
  assert.throws(() => buildHeadlessClaudeInvocation({ prompt: "", runId: "r" }), /prompt/);
  assert.throws(() => buildHeadlessClaudeInvocation({ prompt: "p", runId: "" }), /runId/);
});
