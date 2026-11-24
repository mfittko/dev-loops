import assert from "node:assert/strict";
import test from "node:test";
import { parseHandoffCliArgs, runHandoff } from "../../scripts/loop/copilot-pr-handoff.mjs";

const repoRoot = process.cwd();
const head = "a".repeat(40);
const options = { repo: "owner/repo", pr: 42, codexReviewerSpawnUnavailable: true };

function fixture({ action = "run_draft_gate", mode = "full_fanout", liveHead = head, harness = "codex", fullLabel = true } = {}) {
  const calls = [];
  const claimed = new Error("ordinary handoff reached");
  const env = harness === "codex" ? { CODEX_THREAD_ID: "fixture-lookup-only" } : harness === "claude" ? { CLAUDECODE: "1" } : {};
  return { calls, claimed, runtime: {
    repoRoot,
    env,
    execPreflight(_command, args, config) {
      calls.push(args);
      assert.equal(config.cwd, repoRoot);
      assert.ok(config.timeout > 0);
      assert.equal(config.env, env);
      if (args[0].endsWith("detect-pr-gate-coordination-state.mjs")) return JSON.stringify({ ok: true, nextAction: action, currentHeadSha: head });
      if (args[0].endsWith("view-pr.mjs")) return JSON.stringify({ ok: true, pr: { headRefOid: liveHead, baseRefName: "release", labels: fullLabel ? [{ name: "gate:full" }] : [] } });
      assert.ok(args[0].endsWith("resolve-gate-dispatch.mjs"));
      assert.ok(args.includes("origin/release"));
      assert.ok(args.includes(head));
      assert.equal(args.includes("--full-label"), fullLabel);
      return JSON.stringify({ ok: true, mode });
    },
    async ensureRunnerOwnership() { calls.push("claim"); throw claimed; },
  } };
}

test("internal missing-spawn signal is accepted by the ordinary handoff parser", () => {
  assert.equal(parseHandoffCliArgs(["--repo", options.repo, "--pr", "42", "--codex-reviewer-spawn-unavailable"]).codexReviewerSpawnUnavailable, true);
});

for (const [action, gate, token] of [["run_draft_gate", "draft_gate", "draft"], ["run_pre_approval_gate", "pre_approval_gate", "preApproval"]]) {
  test(`${gate}: missing native spawn refuses before claim; same-head restored retry reaches ordinary handoff`, async () => {
    const f = fixture({ action });
    const result = await runHandoff(options, f.runtime);
    assert.equal(result.code, "FANOUT_UNAVAILABLE");
    assert.equal(result.pr, 42);
    assert.equal(result.headSha, head);
    assert.equal(result.gate, gate);
    assert.equal(result.missingTool, "collaboration.spawn_agent");
    assert.match(result.recovery, /verified Codex child.*collaboration\.spawn_agent/);
    assert.match(result.recovery, /ordinary PR entry/);
    assert.equal(f.calls.includes("claim"), false);
    assert.equal(f.calls.length, 3); // routing + PR facts + dispatch; no emitter or evidence writer
    assert.ok(f.calls[2].includes(token));
    await assert.rejects(runHandoff({ ...options, codexReviewerSpawnUnavailable: false }, f.runtime), f.claimed);
    assert.equal(f.calls.at(-1), "claim");
  });
}

for (const config of [{ action: "wait_for_ci" }, { mode: "inline", fullLabel: false }, { liveHead: "b".repeat(40) }, { harness: "pi" }, { harness: "claude" }]) {
  test(`unaffected entry reaches normal checks: ${JSON.stringify(config)}`, async () => {
    const f = fixture(config);
    await assert.rejects(runHandoff(options, f.runtime), f.claimed);
    assert.equal(f.calls.at(-1), "claim");
  });
}

test("preflight read failures stop before ownership and lightweight routing uses its ordinary flag", async () => {
  const f = fixture();
  const failure = new Error("fixture command failed");
  f.runtime.execPreflight = (_command, args) => {
    assert.ok(args.includes("--lightweight"));
    throw failure;
  };
  await assert.rejects(runHandoff({ ...options, lightweight: true }, f.runtime), failure);
  assert.equal(f.calls.includes("claim"), false);
});
