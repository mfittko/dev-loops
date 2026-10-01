import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";

import { DevLoopConfigSchema, FileConfigSchema, resolveRoleExtraTools } from "../src/config/config.mjs";
import { buildAgentOverrides, buildClaudeLaunch, buildHeadlessClaudeInvocation } from "../src/claude/headless-entry.mjs";
import { decideAgentDispatch } from "../src/claude/hook-decisions.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const withTools = (extraTools) => ({ version: 1, extraTools });
const errorsOf = (extraTools) => {
  const result = FileConfigSchema.safeParse(withTools(extraTools));
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};
const CONFIG = withTools({ developer: ["mcp__codebase-memory"] });

describe("extraTools schema", () => {
  test("accepts each enabled role with valid entries in both schemas", () => {
    for (const role of ["developer", "fixer", "refiner"]) {
      const input = withTools({ [role]: ["mcp__srv", "mcp__srv__*", "mcp__srv__tool_1"] });
      assert.equal(DevLoopConfigSchema.safeParse(input).success, true, role);
      assert.equal(FileConfigSchema.safeParse(input).success, true, role);
    }
  });

  test("rejects built-in names, empty arrays, duplicates, malformed names and over 16 entries", () => {
    for (const bad of [["Read"], [], ["mcp__a", "mcp__a"], ["mcp__"], ["mcp__a!"], ["mcp__a b"],
      Array.from({ length: 17 }, (_, i) => `mcp__s${i}`)]) {
      assert.notEqual(errorsOf({ developer: bad }).length, 0, JSON.stringify(bad));
    }
  });

  test("names hook-guarded roles and unknown roles", () => {
    for (const role of ["judge", "review", "gate-coordinator", "dev-loop"]) {
      assert.deepEqual(errorsOf({ [role]: ["mcp__a"] }), [`role "${role}" is hook-guarded and cannot take extra tools`]);
    }
    assert.deepEqual(errorsOf({ docs: ["mcp__a"] }), ['role "docs" does not support extraTools']);
  });

  test("resolveRoleExtraTools returns the configured array or []", () => {
    assert.deepEqual(resolveRoleExtraTools(CONFIG, "developer"), ["mcp__codebase-memory"]);
    assert.deepEqual(resolveRoleExtraTools(CONFIG, "fixer"), []);
    assert.deepEqual(resolveRoleExtraTools({}, "developer"), []);
    assert.deepEqual(resolveRoleExtraTools(null, "developer"), []);
  });
});

describe("buildAgentOverrides and launcher argv", () => {
  test("renders only roles with entries: mapped built-in tools then deduplicated entries", () => {
    const overrides = buildAgentOverrides(withTools({ developer: ["mcp__codebase-memory", "mcp__codebase-memory__*"] }), repoRoot);
    assert.deepEqual(Object.keys(overrides), ["developer"]);
    assert.deepEqual(overrides.developer.tools, ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "mcp__codebase-memory", "mcp__codebase-memory__*"]);
    assert.match(overrides.developer.prompt, /focused implementation agent/);
  });

  test("returns {} and a bare argv with no extraTools", () => {
    assert.deepEqual(buildAgentOverrides({ version: 1 }, repoRoot), {});
    const launch = buildClaudeLaunch({ config: { version: 1 }, repoRoot, passthroughArgs: ["--resume"], baseEnv: { A: "1" } });
    assert.deepEqual(launch.args, ["--resume"]);
    assert.deepEqual(launch.env, { A: "1" });
  });

  test("launcher and headless argv carry --agents, --allowedTools and DEVLOOPS_AGENT_OVERRIDES", () => {
    const config = withTools({ developer: ["mcp__codebase-memory"], refiner: ["mcp__codebase-memory", "mcp__other"] });
    const launch = buildClaudeLaunch({ config, repoRoot, passthroughArgs: ["--resume"], baseEnv: {} });
    assert.equal(launch.args[0], "--agents");
    assert.deepEqual(Object.keys(JSON.parse(launch.args[1])), ["developer", "refiner"]);
    assert.deepEqual(launch.args.slice(2), ["--allowedTools", "mcp__codebase-memory,mcp__other", "--resume"]);
    assert.equal(launch.env.DEVLOOPS_AGENT_OVERRIDES, "developer,refiner");

    const headless = buildHeadlessClaudeInvocation({ prompt: "p", runId: "r", baseEnv: {}, extraTools: { config, repoRoot } });
    assert.deepEqual(headless.args.slice(0, 2), ["-p", "p"]);
    assert.deepEqual(headless.args.slice(2), launch.args.slice(0, 4));
    assert.equal(headless.env.DEVLOOPS_AGENT_OVERRIDES, "developer,refiner");
  });

  test("a stale DEVLOOPS_AGENT_OVERRIDES is dropped when no role renders", () => {
    const baseEnv = { A: "1", DEVLOOPS_AGENT_OVERRIDES: "developer" };
    assert.deepEqual(buildClaudeLaunch({ config: { version: 1 }, repoRoot, baseEnv }).env, { A: "1" });
    const headless = buildHeadlessClaudeInvocation({ prompt: "p", runId: "r", baseEnv, extraTools: { config: { version: 1 }, repoRoot } });
    assert.equal(headless.env.DEVLOOPS_AGENT_OVERRIDES, undefined);
  });
});

describe("launcher and headless entry scripts", () => {
  const node = Bun.which("node") ?? "node";
  const run = (script, args, cwd = repoRoot) => spawnSync(node, [path.join(repoRoot, script), ...args], { cwd, encoding: "utf8" });

  test("--help prints the launcher usage and does not spawn claude", () => {
    const res = run("scripts/loop/claude-launch.mjs", ["--help"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^Usage: dev-loops loop claude-launch/);
  });

  test("own flags precede a leading -- and the claude args", () => {
    // A fixture cwd keeps the argv independent of this repository's own `.devloops`.
    const dir = mkdtempSync(path.join(tmpdir(), "extra-tools-"));
    try {
      writeFileSync(path.join(dir, ".devloops"), "version: 1\n");
      const dry = (args) => JSON.parse(run("scripts/loop/claude-launch.mjs", ["--dry-run", ...args], dir).stdout);
      const viaBin = dry(["--claude-bin", "x", "--", "--resume"]);
      assert.deepEqual([viaBin.command, viaBin.args], ["x", ["--resume"]]);
      assert.deepEqual(dry(["--resume"]).args, ["--resume"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI route inherits stdio, forwards post--- args and never retries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-tools-"));
    try {
      writeFileSync(path.join(dir, ".devloops"), "version: 1\n");
      const log = path.join(dir, "calls.log");
      const fake = path.join(dir, "fake-claude.mjs");
      writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("Usage: fake");
process.exit(3);
`, { mode: 0o755 });
      const res = spawnSync("node", [path.join(repoRoot, "cli/index.mjs"), "loop", "claude-launch", "--claude-bin", fake, "--", "--help"],
        { cwd: dir, encoding: "utf8" });
      assert.equal(res.status, 3, res.stderr);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [["--help"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--claude-bin without a value is an error", () => {
    const res = run("scripts/loop/claude-launch.mjs", ["--dry-run", "--claude-bin"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--claude-bin requires a path/);
  });

  test("headless entry fails with the config error details", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-tools-"));
    try {
      writeFileSync(path.join(dir, ".devloops"), "version: 1\nextraTools:\n  judge: [mcp__a]\n");
      const res = run("scripts/claude/headless-dev-loop.mjs", ["--issue", "1", "--dry-run"], dir);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /invalid .devloops config: .*hook-guarded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideAgentDispatch with agent overrides", () => {
  const dispatch = (target, agentOverrides) => decideAgentDispatch({ callerAgentType: null, targetAgentType: target, prompt: "x", agentOverrides });

  test("denies a namespaced dispatch of a listed role and names the bare type", () => {
    const decision = dispatch("dev-loops:developer", "developer,fixer");
    assert.match(decision.reason, /dev-loops loop claude-launch/);
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /Dispatch the bare agent type `developer`/);
  });

  test("allows unlisted roles, bare dispatch and an absent variable", () => {
    assert.equal(dispatch("dev-loops:refiner", "developer").decision, "allow");
    assert.equal(dispatch("developer", "developer").decision, "allow");
    assert.equal(dispatch("dev-loops:developer", null).decision, "allow");
    assert.equal(dispatch("dev-loops:developer", undefined).decision, "allow");
    assert.equal(dispatch("acme:developer", "developer").decision, "allow");
  });
});

test("extension README documents extraTools next to models.roleTiers", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(path.join(repoRoot, "extension/README.md"), "utf8");
  assert.ok(readme.indexOf("`models.roleTiers`") < readme.indexOf("(`extraTools`)"));
  for (const text of ["mcp__codebase-memory", "dev-loops loop claude-launch", ".claude/settings.local.json", "classifier may still deny", "Worktree freshness limit"]) {
    assert.ok(readme.includes(text), text);
  }
});
