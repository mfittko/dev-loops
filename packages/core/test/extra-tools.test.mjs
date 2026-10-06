import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";

import { DevLoopConfigSchema, FileConfigSchema, loadDevLoopConfigStrict, resolveExtraToolsGuidance, resolveRoleExtraTools } from "../src/config/config.mjs";
import { buildAgentOverrides, buildClaudeLaunch, buildHeadlessClaudeInvocation, detectSessionMcpServers } from "../src/claude/headless-entry.mjs";
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
    assert.deepEqual(launch.args.slice(2), ["--allowedTools=mcp__codebase-memory,mcp__other", "--resume"]);
    assert.equal(buildClaudeLaunch({ config, repoRoot, passthroughArgs: ["fix X"], baseEnv: {} }).args.at(-1), "fix X");
    assert.equal(launch.env.DEVLOOPS_AGENT_OVERRIDES, "developer,refiner");

    const headless = buildHeadlessClaudeInvocation({ prompt: "p", runId: "r", baseEnv: {}, extraTools: { config, repoRoot } });
    assert.deepEqual(headless.args.slice(0, 2), ["-p", "p"]);
    assert.deepEqual(headless.args.slice(2), launch.args.slice(0, 3));
    assert.equal(headless.env.DEVLOOPS_AGENT_OVERRIDES, "developer,refiner");
  });

  test("a stale DEVLOOPS_AGENT_OVERRIDES is dropped when no role renders", () => {
    const baseEnv = { A: "1", DEVLOOPS_AGENT_OVERRIDES: "developer" };
    assert.deepEqual(buildClaudeLaunch({ config: { version: 1 }, repoRoot, baseEnv }).env, { A: "1" });
    const headless = buildHeadlessClaudeInvocation({ prompt: "p", runId: "r", baseEnv, extraTools: { config: { version: 1 }, repoRoot } });
    assert.equal(headless.env.DEVLOOPS_AGENT_OVERRIDES, undefined);
  });
});

const GUIDED = {
  version: 1,
  extraTools: { developer: ["mcp__srv"], fixer: ["mcp__other"] },
  extraToolsGuidance: { mcp__srv: "Use srv first." },
};

describe("extraToolsGuidance schema", () => {
  const guidanceErrors = (config) => {
    const result = FileConfigSchema.safeParse(config);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  test("accepts a guidance key that a role lists, in both schemas", () => {
    assert.equal(FileConfigSchema.safeParse(GUIDED).success, true);
    assert.equal(DevLoopConfigSchema.safeParse(GUIDED).success, true);
    assert.deepEqual(resolveExtraToolsGuidance(GUIDED), { mcp__srv: "Use srv first." });
    assert.deepEqual(resolveExtraToolsGuidance({ version: 1 }), {});
    assert.deepEqual(resolveExtraToolsGuidance(null), {});
  });

  test("a merged config rejects an unlisted key and names it; a single layer is not judged alone", () => {
    const config = { ...GUIDED, extraToolsGuidance: { mcp__ghost: "x" } };
    const merged = DevLoopConfigSchema.safeParse(config);
    assert.equal(merged.success, false);
    assert.deepEqual(merged.error.issues.map((issue) => issue.message), ['extraToolsGuidance key "mcp__ghost" matches no extraTools entry']);
    const layer = { version: 1, extraToolsGuidance: { mcp__srv: "x" } };
    assert.equal(FileConfigSchema.safeParse(layer).success, true);
    assert.equal(DevLoopConfigSchema.safeParse(layer).success, false);
  });

  test("rejects an empty value, a value over 2000 characters and a malformed key, naming the key", () => {
    for (const value of ["", "   ", "a\n## Other rules", "a\u2028## Other rules", "x".repeat(2001)]) {
      const result = FileConfigSchema.safeParse({ ...GUIDED, extraToolsGuidance: { mcp__srv: value } });
      assert.deepEqual(result.error.issues.map((issue) => issue.path.join(".")), ["extraToolsGuidance.mcp__srv"]);
    }
    assert.equal(FileConfigSchema.safeParse({ ...GUIDED, extraToolsGuidance: { mcp__srv: "x".repeat(2000) } }).success, true);
    assert.notEqual(guidanceErrors({ ...GUIDED, extraToolsGuidance: { Read: "x" } }).length, 0);
  });
});

describe("detectSessionMcpServers", () => {
  const fixture = ({ claudeJson, mcpJson, configDirJson }) => {
    const home = mkdtempSync(path.join(tmpdir(), "mcp-detect-"));
    const project = path.join(home, "proj");
    mkdirSync(project, { recursive: true });
    if (claudeJson !== undefined) writeFileSync(path.join(home, ".claude.json"), typeof claudeJson === "string" ? claudeJson : JSON.stringify(claudeJson(project)));
    if (mcpJson !== undefined) writeFileSync(path.join(project, ".mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
    let configDir;
    if (configDirJson) {
      configDir = path.join(home, "alt");
      mkdirSync(configDir);
      writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify(configDirJson));
    }
    return { home, project, configDir };
  };
  const detect = ({ home, project, configDir }) =>
    [...detectSessionMcpServers({ repoRoot: project, homeDir: home, env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {} })].sort();

  test("reads user, local and project scope and removes disabled servers", () => {
    const f = fixture({
      claudeJson: (project) => ({ mcpServers: { user: {} }, projects: { [project]: { mcpServers: { local: {}, off: {} }, disabledMcpServers: ["off", "user"] } } }),
      mcpJson: { mcpServers: { proj: {} } },
    });
    try {
      assert.deepEqual(detect(f), ["local", "proj"]);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("honors CLAUDE_CONFIG_DIR over the home directory", () => {
    const f = fixture({ claudeJson: () => ({ mcpServers: { home: {} } }), configDirJson: { mcpServers: { alt: {} } } });
    try {
      assert.deepEqual(detect(f), ["alt"]);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("a missing or malformed file contributes nothing and does not throw", () => {
    const missing = fixture({});
    const malformed = fixture({ claudeJson: "{not json", mcpJson: "[1,2" });
    try {
      assert.deepEqual(detect(missing), []);
      assert.deepEqual(detect(malformed), []);
    } finally {
      rmSync(missing.home, { recursive: true, force: true });
      rmSync(malformed.home, { recursive: true, force: true });
    }
  });
});

describe("extraToolsGuidance render", () => {
  const srv = new Set(["srv"]);
  const promptOf = (overrides, role) => overrides[role].prompt;

  test("appends the frame, the condition line and the key line for a detected server", () => {
    const prompt = promptOf(buildAgentOverrides(GUIDED, repoRoot, srv), "developer");
    assert.match(prompt, /\n\n## Session MCP tool guidance\n\nApply a line only when tools named `mcp__<server>__\*` for that server are in your tool list\.\n\n- `mcp__srv`: Use srv first\.$/);
    assert.ok(prompt.indexOf("Apply a line only when") < prompt.indexOf("- `mcp__srv`"));
  });

  test("renders nothing for an undetected server, and for a role that does not list the key", () => {
    const base = promptOf(buildAgentOverrides(withTools(GUIDED.extraTools), repoRoot), "developer");
    assert.equal(promptOf(buildAgentOverrides(GUIDED, repoRoot, new Set()), "developer"), base);
    assert.equal(promptOf(buildAgentOverrides(GUIDED, repoRoot), "developer"), base);
    const overrides = buildAgentOverrides(GUIDED, repoRoot, new Set(["srv", "other"]));
    assert.match(overrides.developer.prompt, /mcp__srv/);
    assert.doesNotMatch(overrides.fixer.prompt, /Session MCP tool guidance/);
  });

  test("matches a detected server whose name holds characters Claude Code maps to underscore", () => {
    const config = { ...GUIDED, extraTools: { developer: ["mcp__code_graph"] }, extraToolsGuidance: { mcp__code_graph: "Use graph." } };
    assert.match(promptOf(buildAgentOverrides(config, repoRoot, new Set(["code.graph"])), "developer"), /- `mcp__code_graph`: Use graph\./);
  });

  test("tools, allowedTools and env are unchanged by guidance and detection", () => {
    const plain = buildClaudeLaunch({ config: withTools(GUIDED.extraTools), repoRoot, baseEnv: {} });
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-launch-"));
    try {
      writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { srv: {} } }));
      const guided = buildClaudeLaunch({ config: GUIDED, repoRoot, projectRoot: dir, baseEnv: { HOME: dir, CLAUDE_CONFIG_DIR: dir } });
      const absent = buildClaudeLaunch({ config: GUIDED, repoRoot, projectRoot: path.join(dir, "none"), baseEnv: { CLAUDE_CONFIG_DIR: dir } });
      const overrides = JSON.parse(guided.args[1]);
      assert.match(overrides.developer.prompt, /Session MCP tool guidance/);
      assert.deepEqual(guided.args.slice(2), plain.args.slice(2));
      assert.deepEqual(guided.env, { ...plain.env, HOME: dir, CLAUDE_CONFIG_DIR: dir });
      assert.equal(absent.args[1], plain.args[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the repo .devloops guidance renders for developer, fixer and refiner when the server is detected", async () => {
  const { config } = await loadDevLoopConfigStrict({ repoRoot });
  const overrides = buildAgentOverrides(config, repoRoot, new Set(["codebase-memory"]));
  for (const role of ["developer", "fixer", "refiner"]) {
    const prompt = overrides[role].prompt;
    assert.match(prompt, /Session MCP tool guidance/, role);
    assert.match(prompt, /call delete_project for that project before your hand-back/, role);
    assert.match(prompt, /call index_repository once on your worktree path/, role);
    assert.match(prompt, /use the main-checkout project and confirm each answer with Read or Grep/, role);
  }
});

test("headless-entry does not import child_process", () => {
  const source = readFileSync(path.join(repoRoot, "packages/core/src/claude/headless-entry.mjs"), "utf8");
  assert.doesNotMatch(source, /child_process/);
});

test("detection ignores array-shaped mcpServers and normalizes the project root", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-detect-"));
  try {
    const project = path.join(home, "proj");
    mkdirSync(project);
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: ["a"], projects: { [project]: { mcpServers: { local: {} } } } }));
    assert.deepEqual([...detectSessionMcpServers({ repoRoot: `${project}/sub/..`, homeDir: home, env: {} })], ["local"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

  test("--dry-run loads .devloops from the git toplevel of a subdirectory, not the package root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-tools-"));
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
      writeFileSync(path.join(dir, ".devloops"), "version: 1\nextraTools:\n  developer: [mcp__consumer-only]\n");
      const sub = path.join(dir, "a", "b");
      mkdirSync(sub, { recursive: true });
      const res = run("scripts/loop/claude-launch.mjs", ["--dry-run"], sub);
      assert.equal(res.status, 0, res.stderr);
      const dry = JSON.parse(res.stdout);
      assert.equal(dry.DEVLOOPS_AGENT_OVERRIDES, "developer");
      assert.ok(dry.args.includes("--allowedTools=mcp__consumer-only"));
      assert.notEqual(dry.DEVLOOPS_AGENT_OVERRIDES, JSON.parse(run("scripts/loop/claude-launch.mjs", ["--dry-run"], repoRoot).stdout).DEVLOOPS_AGENT_OVERRIDES);
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
    assert.match(decision.reason, /dev-loops-run cli\/index\.mjs loop claude-launch/);
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
  for (const text of ["mcp__<server>", "extraToolsGuidance", "## Session MCP tool guidance", "CLAUDE_CONFIG_DIR", "Detection limit", "needs the dev-loops release", "Provisioning does not index", "dev-loops loop claude-launch", ".claude/settings.local.json", "classifier may still deny", "Worktree freshness limit"]) {
    assert.ok(readme.includes(text), text);
  }
});
