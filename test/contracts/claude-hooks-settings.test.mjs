import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
// Hook scripts live under the plugin root (.claude/hooks) so the Claude plugin can bundle them
// via ${CLAUDE_PLUGIN_ROOT}; the repo's own project .claude/settings.json references the same
// scripts via ${CLAUDE_PROJECT_DIR}/.claude/hooks (#824).
const hooksDir = path.join(repoRoot, ".claude", "hooks");

function runHook(script, payload, env = {}) {
  // Build a clean env with the run-id markers explicitly removed (not set to `undefined`, whose
  // spawnSync handling is version-dependent and could coerce to the string "undefined").
  // Marker names come from the adapter (run-context) so this file names no harness env vars —
  // the cli-harness-agnostic contract confines those literals to the adapter boundary.
  const childEnv = { ...process.env };
  for (const marker of RUN_ID_MARKERS) delete childEnv[marker];
  // Strip the SubagentStop exemption signal so non-exempt tests are deterministic regardless of
  // host env (a leaked DEVLOOPS_COMMIT_AUTH_PENDING=1 would silently exempt the dirty case).
  // The exempt test explicitly sets it to "1" below, which overrides this. #1619 review finding.
  delete childEnv["DEVLOOPS_COMMIT_AUTH_PENDING"];
  const res = spawnSync("node", [path.join(hooksDir, script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...childEnv, ...env },
  });
  let json = null;
  try {
    json = res.stdout.trim() ? JSON.parse(res.stdout) : null;
  } catch {
    json = null;
  }
  // SubagentStop blocks via exit code 2 + stderr JSON (unlike PreToolUse's stdout JSON), so
  // surface stderr for those assertions.
  let stderrJson = null;
  try {
    stderrJson = res.stderr.trim() ? JSON.parse(res.stderr) : null;
  } catch {
    stderrJson = null;
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json, stderrJson };
}

test(".claude/settings.json is valid JSON and wires the four dev-loop hook registrations", () => {
  const raw = fs.readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8");
  const settings = JSON.parse(raw);
  const pre = settings.hooks.PreToolUse;
  const post = settings.hooks.PostToolUse;

  const bashGate = pre.find((h) => h.matcher === "Bash");
  const writeGuard = pre.find((h) => h.matcher === "Edit|Write");
  const postMerge = post.find((h) => h.matcher === "Bash");
  const subagentStop = settings.hooks.SubagentStop?.find((h) => h.matcher === "*");

  // Project hooks reference the scripts under .claude/hooks via ${CLAUDE_PROJECT_DIR} (#824).
  assert.match(bashGate.hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/pre-tool-use-bash-gate\.mjs/);
  assert.match(writeGuard.hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/pre-tool-use-write-guard\.mjs/);
  assert.match(postMerge.hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/post-tool-use-merge\.mjs/);
  assert.ok(subagentStop, "SubagentStop matcher must be registered");
  assert.match(subagentStop.hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/subagent-stop-uncommitted-guard\.mjs/);
});

test(".claude/hooks/hooks.json wires the plugin hooks via ${CLAUDE_PLUGIN_ROOT} (#824)", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude", "hooks", "hooks.json"), "utf8")).hooks;
  const bashGate = hooks.PreToolUse.find((h) => h.matcher === "Bash");
  const writeGuard = hooks.PreToolUse.find((h) => h.matcher === "Edit|Write");
  const postMerge = hooks.PostToolUse.find((h) => h.matcher === "Bash");
  const subagentStop = hooks.SubagentStop?.find((h) => h.matcher === "*");
  assert.match(bashGate.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/pre-tool-use-bash-gate\.mjs/);
  assert.match(writeGuard.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/pre-tool-use-write-guard\.mjs/);
  assert.match(postMerge.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/post-tool-use-merge\.mjs/);
  assert.ok(subagentStop, "SubagentStop matcher must be registered in hooks.json");
  assert.match(subagentStop.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/subagent-stop-uncommitted-guard\.mjs/);
});

test("the three hook scripts (+ _hook-io) exist under the plugin root", () => {
  for (const script of ["_hook-io.mjs", "pre-tool-use-bash-gate.mjs", "pre-tool-use-write-guard.mjs", "post-tool-use-merge.mjs"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, script)), `missing hook script ${script}`);
  }
});

test("the SubagentStop uncommitted-work guard hook exists under the plugin root (#1619)", () => {
  assert.ok(fs.existsSync(path.join(hooksDir, "subagent-stop-uncommitted-guard.mjs")), "missing subagent-stop-uncommitted-guard.mjs");
});

test("the self-contained hook bundle modules exist under the plugin root (#843)", () => {
  for (const module of ["_bash-command-classify.mjs", "_run-context.mjs", "_hook-decisions.mjs"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, module)), `missing bundled module ${module}`);
  }
});

test("no .claude/hooks script imports an unresolvable bare package (#843)", () => {
  // The marketplace plugin bundle has no node_modules, so a bare specifier like
  // `@dev-loops/core/...` is unresolvable from the plugin cache and crashes the hook on load.
  // Hooks (and their vendored bundle modules) may only import `node:` builtins or relative paths.
  const importPattern = /^\s*(?:import|export)\b[^"';]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  const offenders = [];
  for (const file of fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs"))) {
    const body = fs.readFileSync(path.join(hooksDir, file), "utf8");
    // Fresh regex per file: a shared /g regex would carry `lastIndex` across files and skip
    // imports at the top of later files (Copilot review, PR #844).
    for (const match of body.matchAll(new RegExp(importPattern))) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const resolvable = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
      if (!resolvable) offenders.push(`${file} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Bundled hooks must only import node: builtins or relative paths (no node_modules in the plugin):\n${offenders.join("\n")}`,
  );
});

test("package.json files allowlist ships the plugin hooks", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(pkg.files.includes(".claude/hooks/"), "files allowlist must ship .claude/hooks/");
});

test("bash-gate hook passes through non-gh-pr-ready commands", () => {
  const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.equal(json, null, "no deny output for an allowed command");
});

test("bash-gate hook denies an ungated gh pr ready in the target repo (e2e, stubbed guard)", () => {
  // Stub the gate guard to exit 1 (no clean draft_gate evidence) so the spawn + deny wiring is
  // exercised deterministically without touching the network.
  const stub = path.join(repoRoot, "tmp", `gate-stub-deny-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, "process.exit(1);\n", "utf8");
  try {
    const { code, json } = runHook(
      "pre-tool-use-bash-gate.mjs",
      { tool_name: "Bash", tool_input: { command: "gh pr ready 999999" }, cwd: repoRoot },
      { DEVLOOPS_PRE_PR_READY_GATE_SCRIPT: stub },
    );
    assert.equal(code, 0);
    assert.ok(json, "expected a structured decision");
    assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /draft_gate/);
  } finally {
    fs.rmSync(stub, { force: true });
  }
});

test("bash-gate hook allows gh pr ready when the (stubbed) draft gate passes", () => {
  const stub = path.join(repoRoot, "tmp", `gate-stub-pass-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, "process.exit(0);\n", "utf8");
  try {
    const { code, json } = runHook(
      "pre-tool-use-bash-gate.mjs",
      { tool_name: "Bash", tool_input: { command: "gh pr ready 999999" }, cwd: repoRoot },
      { DEVLOOPS_PRE_PR_READY_GATE_SCRIPT: stub },
    );
    assert.equal(code, 0);
    assert.equal(json, null, "gate-passed ready must be allowed");
  } finally {
    fs.rmSync(stub, { force: true });
  }
});

test("bash-gate hook denies a raw gh pr create in the target repo (e2e)", () => {
  // No gate stub needed — create is an unconditional block routing to the wrapper.
  const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
    tool_name: "Bash",
    tool_input: { command: "gh pr create --title x --body y" },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.ok(json, "expected a structured decision");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /create-pr\.mjs/);
});

test("bash-gate hook allows the create-pr.mjs wrapper (e2e)", () => {
  const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
    tool_name: "Bash",
    tool_input: { command: "node scripts/github/create-pr.mjs --title x --fill" },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.equal(json, null, "the canonical wrapper must pass through");
});

test("bash-gate hook denies an inline interpreter in the target repo (e2e, #1622 decision seam)", () => {
  // Regression for the #1622 enforcement-seam finding: the six guard-rule predicates are decided in
  // decideBashGate, so the real hook deny path (line ~65 short-circuit) must exercise at least one of
  // them. Reverting the predicate from the early-return short-circuit must fail this test.
  const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
    tool_name: "Bash",
    tool_input: { command: 'node -e "console.log(1)"' },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.ok(json, "expected a structured deny for an inline interpreter");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /OPS-NO-INLINE-INTERPRETER/);
});

test("bash-gate hook denies a raw gh api sub_issues write in the target repo (e2e, #1622)", () => {
  const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
    tool_name: "Bash",
    tool_input: { command: "gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6" },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.ok(json, "expected a structured deny for a sub_issues write");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /manage-sub-issues/);
});

test("write-guard hook fails open when enforcement is disabled (default)", () => {
  const { code, json } = runHook("pre-tool-use-write-guard.mjs", {
    tool_name: "Write",
    tool_input: { file_path: path.join(repoRoot, "package.json") },
    cwd: repoRoot,
  });
  assert.equal(code, 0);
  assert.equal(json, null, "no deny when DEVLOOPS_MAIN_AGENT_READONLY is unset");
});

test("write-guard hook denies a main-agent repo mutation under strict enforcement", () => {
  const { code, json } = runHook(
    "pre-tool-use-write-guard.mjs",
    { tool_name: "Write", tool_input: { file_path: path.join(repoRoot, "package.json") }, cwd: repoRoot },
    { DEVLOOPS_MAIN_AGENT_READONLY: "1" },
  );
  assert.equal(code, 0);
  assert.ok(json, "expected a structured decision");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /Main-agent read-only boundary/);
});

test("write-guard hook allows a dev-loop subagent (run id) mutation under strict enforcement", () => {
  const { code, json } = runHook(
    "pre-tool-use-write-guard.mjs",
    { tool_name: "Write", tool_input: { file_path: path.join(repoRoot, "package.json") }, cwd: repoRoot },
    { DEVLOOPS_MAIN_AGENT_READONLY: "1", DEVLOOPS_RUN_ID: "devloops-test" },
  );
  assert.equal(code, 0);
  assert.equal(json, null, "subagent run-id context must be allowed");
});

test("write-guard hook allows a gitignored path under strict enforcement", () => {
  const { code, json } = runHook(
    "pre-tool-use-write-guard.mjs",
    { tool_name: "Write", tool_input: { file_path: path.join(repoRoot, "tmp", "scratch.txt") }, cwd: repoRoot },
    { DEVLOOPS_MAIN_AGENT_READONLY: "1" },
  );
  assert.equal(code, 0);
  assert.equal(json, null, "gitignored tmp/ path must be allowed");
});

// ---------------------------------------------------------------------------
// SubagentStop uncommitted-work guard (#1619) — e2e hook script behavior
// ---------------------------------------------------------------------------
// The guard fires only under tmp/worktrees/. Build a throwaway git repo there so the hook's
// real `git status --porcelain` + decider path is exercised end to end (not just the pure
// decider, which is covered in packages/core/test/claude-hook-decisions.test.mjs). Mutation
// anchor: revert the guard's block branch and the dirty case stops blocking.

function makeWorktree(slug, dirty) {
  const dir = path.join(repoRoot, "tmp", "worktrees", `subagent-stop-test-${slug}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  // A fresh `git init` is already a clean worktree (empty `git status --porcelain`). git commit
  // is intentionally avoided so the test does not depend on a configured git user identity —
  // CI runners may omit user.name/user.email, which left `committed.txt` staged and made the
  // "clean" case dirty (the #1619 CI regression). An untracked file is enough to be dirty.
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (dirty) {
    fs.writeFileSync(path.join(dir, "uncommitted.txt"), "dirty\n", "utf8");
  }
  return dir;
}

test("SubagentStop hook blocks a subagent stop with a dirty worktree under tmp/worktrees/ (#1619)", () => {
  const dir = makeWorktree("dirty", true);
  try {
    const { code, stderrJson } = runHook("subagent-stop-uncommitted-guard.mjs", { cwd: dir });
    assert.equal(code, 2, "dirty worktree must be refused (exit 2)");
    assert.ok(stderrJson, "block reason JSON on stderr");
    assert.equal(stderrJson.decision, "block");
    assert.match(stderrJson.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
    assert.match(stderrJson.reason, /uncommitted\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SubagentStop hook allows a clean worktree under tmp/worktrees/ (#1619)", () => {
  const dir = makeWorktree("clean", false);
  try {
    const { code, stderrJson } = runHook("subagent-stop-uncommitted-guard.mjs", { cwd: dir });
    assert.equal(code, 0, "clean worktree must stop normally");
    assert.equal(stderrJson, null, "no block output for a clean worktree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SubagentStop hook is unaffected by a cwd outside tmp/worktrees/ (#1619)", () => {
  // A cwd that is genuinely NOT under tmp/worktrees/ (os.tmpdir() is outside the repo tree).
  // The guard short-circuits on isUnderWorktreePath before git even runs, so the stop is allowed
  // regardless of git state. (repoRoot itself is under tmp/worktrees/ when tests run from a
  // worktree, so it cannot stand in for the outside case here.)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-stop-outside-"));
  try {
    const { code, stderrJson } = runHook("subagent-stop-uncommitted-guard.mjs", { cwd: outside });
    assert.equal(code, 0, "cwd outside tmp/worktrees/ must be unaffected");
    assert.equal(stderrJson, null);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("SubagentStop hook exempts an interactive session awaiting commit authorization (#1619)", () => {
  const dir = makeWorktree("exempt", true);
  try {
    const { code, stderrJson } = runHook(
      "subagent-stop-uncommitted-guard.mjs",
      { cwd: dir },
      { DEVLOOPS_COMMIT_AUTH_PENDING: "1" },
    );
    assert.equal(code, 0, "pending-commit-authorization session must be exempt");
    assert.equal(stderrJson, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
