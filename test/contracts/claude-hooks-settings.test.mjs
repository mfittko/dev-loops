import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hooksDir = path.join(repoRoot, "scripts", "claude", "hooks");

function runHook(script, payload, env = {}) {
  // Build a clean env with the run-id markers explicitly removed (not set to `undefined`, whose
  // spawnSync handling is version-dependent and could coerce to the string "undefined").
  const childEnv = { ...process.env };
  delete childEnv.DEVLOOPS_RUN_ID;
  delete childEnv.PI_SUBAGENT_RUN_ID;
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
  return { code: res.status, stdout: res.stdout, json };
}

test(".claude/settings.json is valid JSON and wires the three dev-loop hooks", () => {
  const raw = fs.readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8");
  const settings = JSON.parse(raw);
  const pre = settings.hooks.PreToolUse;
  const post = settings.hooks.PostToolUse;

  const bashGate = pre.find((h) => h.matcher === "Bash");
  const writeGuard = pre.find((h) => h.matcher === "Edit|Write");
  const postMerge = post.find((h) => h.matcher === "Bash");

  assert.match(bashGate.hooks[0].command, /pre-tool-use-bash-gate\.mjs/);
  assert.match(writeGuard.hooks[0].command, /pre-tool-use-write-guard\.mjs/);
  assert.match(postMerge.hooks[0].command, /post-tool-use-merge\.mjs/);
});

test("the three hook scripts exist", () => {
  for (const script of ["pre-tool-use-bash-gate.mjs", "pre-tool-use-write-guard.mjs", "post-tool-use-merge.mjs"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, script)), `missing hook script ${script}`);
  }
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
