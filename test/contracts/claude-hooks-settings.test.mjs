import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";
import { evaluateSubagentStop } from "../../.claude/hooks/subagent-stop-uncommitted-guard.mjs";
import { runSubagentStopReaper, discoverOwnBackgroundShells, signalGroup } from "../../.claude/hooks/subagent-stop-reaper.mjs";

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
  // Strip the one SubagentStop exemption signal the hook still reads so non-exempt tests are
  // deterministic regardless of host env (a leaked DEVLOOPS_COMMIT_AUTH_PENDING=1 would silently
  // exempt the dirty case). The exempt test explicitly sets it to "1" below, which overrides this.
  // #1619 review finding. The #1786 DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT exemption was removed in
  // #1936, so the hook no longer reads that var — a leaked host value is inert and needs no strip;
  // the #1936 "no escape" tests still set it explicitly to prove it grants no exemption.
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
  // #2065: the background-shell reaper is wired alongside the uncommitted-work guard.
  assert.match(subagentStop.hooks[1].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/subagent-stop-reaper\.mjs/);
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
  // #2065: the reaper is wired alongside the uncommitted-work guard in the plugin manifest too.
  assert.match(subagentStop.hooks[1].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/subagent-stop-reaper\.mjs/);
});

test("the three hook scripts (+ _hook-io) exist under the plugin root", () => {
  for (const script of ["_hook-io.mjs", "pre-tool-use-bash-gate.mjs", "pre-tool-use-write-guard.mjs", "post-tool-use-merge.mjs"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, script)), `missing hook script ${script}`);
  }
});

test("the SubagentStop uncommitted-work guard hook exists under the plugin root (#1619)", () => {
  assert.ok(fs.existsSync(path.join(hooksDir, "subagent-stop-uncommitted-guard.mjs")), "missing subagent-stop-uncommitted-guard.mjs");
});

test("the SubagentStop background-shell reaper hook exists under the plugin root (#2065)", () => {
  assert.ok(fs.existsSync(path.join(hooksDir, "subagent-stop-reaper.mjs")), "missing subagent-stop-reaper.mjs");
});

test("SubagentStop reaper reaps ONLY the agent's own discovered shells and always allows the stop (#2065)", () => {
  const signalled = [];
  const code = runSubagentStopReaper({
    input: {},
    stderr: { write: () => {} },
    platform: "linux",
    selfPid: 999,
    // discover returns the reaper's own background shells + the protected group leader (pgid)
    discover: () => ({ sid: 500, pids: [4242, 4243] }),
    signal: (pid) => signalled.push(pid),
  });
  assert.equal(code, 0, "the reaper never blocks the stop");
  assert.deepEqual(signalled, [4242, 4243], "reaps exactly the discovered own detached job-group leaders");
});

test("SubagentStop reaper is a no-op when nothing is discovered (#2065)", () => {
  const signalled = [];
  const code = runSubagentStopReaper({
    input: {},
    stderr: { write: () => {} },
    platform: "linux",
    selfPid: 999,
    discover: () => ({ sid: null, pids: [] }),
    signal: (pid) => signalled.push(pid),
  });
  assert.equal(code, 0);
  assert.deepEqual(signalled, [], "no shells signalled when there is nothing to reap");
});

test("discoverOwnBackgroundShells returns ONLY session-scoped, wait/probe-matching process-group leaders, excluding self + session leader (#2065, Copilot review)", () => {
  // Injected `ps`: first call resolves the reaper's own session id; second lists all processes as
  // `pid pgid sess command` rows. Only rows in session 500 that are group leaders (pid === pgid),
  // are neither the reaper (999) nor the session leader (500), AND whose command matches the
  // wait/probe helper signature may be reaped.
  const calls = [];
  const execFileSyncImpl = (cmd, args) => {
    calls.push(args.join(" "));
    if (args.includes("-p")) return "500\n"; // ps -o sess= -p 999  → session 500
    // ps -A -o pid=,pgid=,sess=,command=
    return [
      "500 500 500 -bash", // session leader (the agent/shell) — excluded (pid === sid)
      "999 999 500 node .claude/hooks/subagent-stop-reaper.mjs", // the reaper itself — excluded (pid === selfPid)
      "4242 4242 500 node scripts/github/probe-copilot-review.mjs --pr 5", // detached wait-shell leader in our session — REAP
      "4243 4243 500 gh run watch 123 --repo o/r", // detached wait-shell leader in our session — REAP
      "5000 500 500 node scripts/foo.mjs", // foreground sibling sharing the session-leader's group (pid !== pgid) — skip
      "6000 6000 700 gh run watch 999", // a matching group leader in a DIFFERENT session — skip
      "garbage row",
    ].join("\n") + "\n";
  };
  const { sid, pids } = discoverOwnBackgroundShells({ selfPid: 999, execFileSyncImpl });
  assert.equal(sid, 500);
  assert.deepEqual(pids, [4242, 4243]);
});

test("discoverOwnBackgroundShells reaps a matching wait-shell leader but NOT a non-matching detached leader in the same session (#2065, Copilot review — ownership boundary)", () => {
  // Both 4242 and 5555 are session-scoped process-GROUP LEADERS (pid === pgid), so the OLD
  // session+group-leader-only boundary would have reaped both. Only 4242's command matches the
  // wait/probe helper signature; 5555 is an unrelated detached process (e.g. the ui-review skill's
  // server, spawned with `{ detached: true }`) that must be left alone by construction.
  const execFileSyncImpl = (cmd, args) => {
    if (args.includes("-p")) return "500\n"; // ps -o sess= -p 999  → session 500
    return [
      "500 500 500 -bash",
      "999 999 500 node .claude/hooks/subagent-stop-reaper.mjs",
      "4242 4242 500 node scripts/github/probe-copilot-review.mjs --repo o/r --pr 5 --timeout-ms 300000",
      "5555 5555 500 node scripts/ui-review-server.mjs --port 4173",
    ].join("\n") + "\n";
  };
  const { sid, pids } = discoverOwnBackgroundShells({ selfPid: 999, execFileSyncImpl });
  assert.equal(sid, 500);
  assert.deepEqual(pids, [4242], "only the wait/probe-matching leader is reapable; the detached UI-review server is not");
});

test("discoverOwnBackgroundShells fails safe (empty) when ps errors (#2065)", () => {
  const throwing = () => { throw new Error("ps unavailable"); };
  assert.deepEqual(discoverOwnBackgroundShells({ selfPid: 999, execFileSyncImpl: throwing }), { sid: null, pids: [] });
});

test("signalGroup targets the process GROUP and refuses a non-positive-integer pid (#2065)", () => {
  const sent = [];
  signalGroup(4242, { killImpl: (target, sig) => sent.push([target, sig]) });
  assert.deepEqual(sent, [[-4242, "SIGTERM"]], "signals the negative pid (process group) only");
  for (const bad of [0, 1, -3, 2.5, Number.NaN]) {
    assert.throws(() => signalGroup(bad, { killImpl: () => {} }), /non-positive-integer/);
  }
});

test("signalGroup NEVER falls back to a positive-pid kill when the group signal fails (#2288 review — TOCTOU pid-reuse safety)", () => {
  // A `ps`-discovered leader's group may already be gone (ESRCH) or unsignallable (EPERM) by the
  // time the reaper fires — the TOCTOU window between discovery and signalling. Unlike
  // `ui-review-teardown`'s `signalProcess` (a known, just-spawned pid with no reuse window), this
  // reaper must NEVER retry with the bare positive pid: it may since have been reused by an
  // unrelated process. Both error shapes below must swallow silently with no second kill call.
  for (const errCode of ["ESRCH", "EPERM", "EOTHER"]) {
    const sent = [];
    const err = new Error(errCode);
    err.code = errCode;
    assert.doesNotThrow(() =>
      signalGroup(4242, {
        killImpl: (target) => {
          sent.push(target);
          throw err;
        },
      }),
    );
    assert.deepEqual(sent, [-4242], `only the group signal (-pid) is attempted for ${errCode}, never a positive-pid fallback`);
  }
});

test("SubagentStop reaper fails closed on win32 — no shell is signalled (#2065)", () => {
  const signalled = [];
  const code = runSubagentStopReaper({
    input: {},
    stderr: { write: () => {} },
    platform: "win32",
    selfPid: 999,
    discover: () => ({ sid: 500, pids: [4242, 4243] }),
    signal: (pid) => signalled.push(pid),
  });
  assert.equal(code, 0);
  assert.deepEqual(signalled, [], "win32 must not signal any process group (fail closed)");
});

test("the self-contained hook bundle modules exist under the plugin root (#843)", () => {
  for (const module of ["_bash-command-classify.mjs", "_run-context.mjs", "_hook-decisions.mjs"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, module)), `missing bundled module ${module}`);
  }
});

test("merge hook descriptions retain the transition owner without requiring a current-head draft gate", () => {
  for (const file of [
    "packages/core/src/claude/hook-decisions.mjs",
    ".claude/hooks/_hook-decisions.mjs",
    ".claude/hooks/pre-tool-use-bash-gate.mjs",
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const description = source.match(/\*\s+- `gh pr merge`[^]*?(?=\n \*\s+-)/)?.[0];
    assert.ok(description, `${file} must describe its merge boundary`);
    assert.match(description, /GATE-COMMENT-DRAFT-REQUIREMENTS/);
    assert.match(description, /skills\/docs\/gate-review-comment-contract\.md/);
    assert.doesNotMatch(description, /current[- ]head\s+draft_gate/);
    assert.match(description, /current[- ]head\s+pre_approval_gate/);
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

// A throwaway git repo (outside this repo's own worktree) carrying only a `.devloops` config
// file variant — enough for `git rev-parse --show-toplevel` to resolve without a remote (the
// managed-context check never needs repoSlug).
function makeManagedConfigRepo(configFilename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-gate-devloops-variant-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (configFilename) {
    fs.writeFileSync(path.join(dir, configFilename), "schemaVersion: 1\n", "utf8");
  }
  return dir;
}

test("bash-gate hook recognizes every .devloops config variant (bare/.yaml/.yml/.json) as a managed repo — denies git stash (e2e, config-variant fail-closed gap)", () => {
  // Mirrors the config loader's own variant list (config.mjs's `["", ".yaml", ".yml", ".json"]`
  // loop). git stash is a clean signal here: `inManagedRepo` (and thus the deny) is gated purely
  // on `inManagedContext`, with no repoSlug/network dependency to stub.
  for (const ext of ["", ".yaml", ".yml", ".json"]) {
    const dir = makeManagedConfigRepo(`.devloops${ext}`);
    try {
      const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git stash" },
        cwd: dir,
      });
      assert.equal(code, 0);
      assert.ok(json, `.devloops${ext} must be recognized as a managed-repo config (git stash must be denied)`);
      assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
      assert.match(json.hookSpecificOutput.permissionDecisionReason, /git stash blocked/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("bash-gate hook allows git stash in a repo with no .devloops config at all (unmanaged, pass-through)", () => {
  const dir = makeManagedConfigRepo(null);
  try {
    const { code, json } = runHook("pre-tool-use-bash-gate.mjs", {
      tool_name: "Bash",
      tool_input: { command: "git stash" },
      cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json, null, "an unmanaged repo (no .devloops config present) must not gate git stash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Wrong-checkout guard — e2e hook script behavior (boundary 1)
// ---------------------------------------------------------------------------
// The pure decider is unit-tested in packages/core/test/claude-hook-decisions.test.mjs;
// these exercise the hand-authored hook WIRING end to end: the git-worktree-list /
// check-ignore fact resolution, realpathNearestExisting, the suggested-path hint, AND the
// outer-catch fail-safe that denies an escaping write when `git worktree list` is
// unresolvable while cwd is under a worktree (AC4). Always-on: no DEVLOOPS_MAIN_AGENT_READONLY.
// Mutation anchor: revert the catch-block fail-safe and the escaping-target deny stops firing.

// Hermetic git env for the throwaway fixtures: pin an identity (CI runners may omit
// user.name/email) AND clear any ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so the
// fixture's git commands can never operate on the wrong repo (e.g. when these tests run
// inside a git hook or a CI step that sets them). Matches the repo's fixture convention.
const HERMETIC_GIT_ENV = (() => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[v];
  return env;
})();
// `-c commit.gpgsign=false` (a repo-local signing config would fail the throwaway commit)
// and `-c core.hooksPath=` (never run this repo's own hooks against the fixture).
const gitFixture = (args, cwd) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], { cwd, encoding: "utf8", env: HERMETIC_GIT_ENV });

// A self-contained main checkout + a real linked worktree under its tmp/worktrees/, in os.tmpdir()
// (never under this repo, so it never pollutes repoRoot's own `git worktree list`).
function makeMainAndLinkedWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-e2e-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main, { recursive: true });
  const git = (args, cwd) => gitFixture(args, cwd);
  git(["init", "-q", "-b", "main"], main);
  fs.writeFileSync(path.join(main, "seed.txt"), "seed\n", "utf8");
  git(["add", "seed.txt"], main);
  git(["commit", "-qm", "seed"], main);
  const wt = path.join(main, "tmp", "worktrees", "dev-loops", "issue-x");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(["worktree", "add", "-q", "-b", "issue-x", wt], main);
  return { root, main, wt };
}

test("write-guard hook DENIES a main-checkout tracked-path write while cwd is a linked worktree (#1994 e2e, AC1)", () => {
  const { root, main, wt } = makeMainAndLinkedWorktree();
  try {
    const { code, json } = runHook("pre-tool-use-write-guard.mjs", {
      tool_name: "Write",
      tool_input: { file_path: path.join(main, "scripts", "x.mjs") }, // MAIN checkout, not the worktree
      cwd: wt,
    });
    assert.equal(code, 0);
    assert.ok(json, "expected a structured deny decision");
    assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /WORKTREE-WRONG-CHECKOUT-GUARD/);
    // the hint names the worktree-local path to use instead
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /issue-x[/\\]scripts[/\\]x\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("write-guard hook ALLOWS an in-worktree write from a linked worktree cwd (#1994 e2e, AC2)", () => {
  const { root, wt } = makeMainAndLinkedWorktree();
  try {
    const { code, json } = runHook("pre-tool-use-write-guard.mjs", {
      tool_name: "Write",
      tool_input: { file_path: path.join(wt, "scripts", "x.mjs") },
      cwd: wt,
    });
    assert.equal(code, 0);
    assert.equal(json, null, "an in-worktree write must be allowed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("write-guard hook DENIES again with DEVLOOPS_ALLOW_MAIN unset but ALLOWS with it set (#1994 e2e, AC3 override)", () => {
  const { root, main, wt } = makeMainAndLinkedWorktree();
  try {
    const payload = { tool_name: "Write", tool_input: { file_path: path.join(main, "scripts", "x.mjs") }, cwd: wt };
    assert.equal(runHook("pre-tool-use-write-guard.mjs", payload).json.hookSpecificOutput.permissionDecision, "deny");
    const overridden = runHook("pre-tool-use-write-guard.mjs", payload, { DEVLOOPS_ALLOW_MAIN: "1" });
    assert.equal(overridden.json, null, "DEVLOOPS_ALLOW_MAIN=1 authorizes the deliberate main-checkout write");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC4 fail-safe, hook Path B: `git worktree list` is UNRESOLVABLE (cwd is a non-git dir whose
// path is under tmp/worktrees/). The guard must still refuse a write escaping cwd's subtree.
function makeNonGitWorktreeDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-nogit-"));
  const dir = path.join(root, "tmp", "worktrees", "dev-loops", "issue-y");
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test("write-guard hook FAILS SAFE (deny) on an unresolvable git-worktree-list context while under a worktree (#1994 e2e, AC4)", () => {
  const { root, dir } = makeNonGitWorktreeDir();
  try {
    // Target escapes cwd's subtree → deny (fail-safe).
    const escaping = runHook("pre-tool-use-write-guard.mjs", {
      tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "elsewhere.txt") }, cwd: dir,
    });
    assert.equal(escaping.code, 0);
    assert.ok(escaping.json, "expected a structured deny decision");
    assert.equal(escaping.json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(escaping.json.hookSpecificOutput.permissionDecisionReason, /WORKTREE-WRONG-CHECKOUT-GUARD/);

    // A write inside cwd's own subtree is still allowed.
    const inside = runHook("pre-tool-use-write-guard.mjs", {
      tool_name: "Write", tool_input: { file_path: path.join(dir, "sub", "f.txt") }, cwd: dir,
    });
    assert.equal(inside.json, null, "in-cwd-subtree write must be allowed even when git-list is unresolvable");

    // The override authorizes the escaping write.
    const overridden = runHook("pre-tool-use-write-guard.mjs", {
      tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "elsewhere.txt") }, cwd: dir,
    }, { DEVLOOPS_ALLOW_MAIN: "1" });
    assert.equal(overridden.json, null, "DEVLOOPS_ALLOW_MAIN=1 overrides the fail-safe deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const decision = evaluateSubagentStop({ cwd: dir });
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
    assert.match(decision.reason, /uncommitted\.txt/);
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

test("SubagentStop hook stays enforced for an editing dispatch — the removed orchestrator-owned-commit env var grants no escape (#1936)", () => {
  // #1936: the #1786 DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT exemption was removed. Setting it (as a
  // leaked/stale env var) must NOT exempt a dirty worktree — the "edit here, commit there" split
  // that deadlocked an editing subagent under a task-scoped no-commit instruction is gone. The
  // only resolution is to commit the dispatch's own work. Mutation anchor: reintroducing the
  // env-var allow branch in the hook would flip this exit code back to 0 and re-open the deadlock.
  const decision = evaluateSubagentStop(
    { cwd: path.join(repoRoot, "tmp", "worktrees", "editing") },
    {
      env: { DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT: "1" },
      execFileSyncImpl: () => "?? uncommitted.txt\n",
    },
  );
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
});

test("SubagentStop hook fail-safe-allows a mkdir-only (non-git) dir under tmp/worktrees/ (#1685)", () => {
  // Every makeWorktree() fixture calls `git init`, so the hook always sees a valid git repo and
  // the fail-safe-allow catch path (`execFileSync("git", ["status","--porcelain"], { timeout:
  // 5000 })` throws → porcelain="" → allow the stop) is never exercised e2e. This test creates
  // the dir with `mkdir` only (no `git init`) OUTSIDE any git repo — so `git status --porcelain`
  // throws and the catch allows the stop: exit 0 + no block output. A dir under the repo's own
  // tmp/worktrees/ is nested inside the surrounding git repo, so git status would succeed there
  // and report the untracked dir as dirty instead of throwing; hosting the non-git dir under
  // os.tmpdir() (outside every repo, like the existing outside-path test) makes git genuinely
  // fail while the path still carries a tmp/worktrees/ segment so isUnderWorktreePath stays real.
  // Non-goal: the fail-safe allow on git error/timeout is the correct behavior — this test pins
  // it, it does not change it.
  const dir = path.join(os.tmpdir(), "tmp", "worktrees", `subagent-stop-test-nongit-${process.pid}`);
  // mkdir only — deliberately NO `git init` (and outside any git repo)
  fs.mkdirSync(dir, { recursive: true });
  try {
    const { code, stderrJson } = runHook("subagent-stop-uncommitted-guard.mjs", { cwd: dir });
    assert.equal(code, 0, "non-git dir under tmp/worktrees/ must fail-safe allow the stop (exit 0)");
    assert.equal(stderrJson, null, "fail-safe-allow path must not emit block output");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SubagentStop hook still blocks when porcelain output exceeds the 1MB Node default maxBuffer (#1686)", () => {
  // With Node's default execFileSync maxBuffer (1MB), `git status --porcelain` throws
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER once the output crosses that size, and the catch
  // turns that into a fail-safe allow — defeating the guard on exactly the worktrees
  // with the most uncommitted work. The hook raises maxBuffer to 10MB; this test
  // creates enough long-named untracked files to push porcelain past 1MB and asserts
  // the guard still blocks. Each fixture file's porcelain line is the `?? ` status prefix
  // (3 bytes) + the filename + a newline (1 byte); with the 241-byte filename below that's
  // 245 bytes/line, so ~4600 files (~1.1MB) clears the 1MB bound while real (much shorter)
  // paths need far more to hit the same bound. Beyond 10MB (~43k+ such long-line paths) the
  // fail-safe allow is the documented ceiling.
  const name = (i) => `f${String(i).padStart(5, "0")}-${"x".repeat(230)}.txt`;
  const porcelain = Array.from({ length: 4600 }, (_, i) => `?? ${name(i)}`).join("\n");
  const dirtyLineCount = porcelain.split("\n").length;
  assert.ok(Buffer.byteLength(porcelain, "utf8") > 1024 * 1024);
  let commandOptions;
  const decision = evaluateSubagentStop(
    { cwd: path.join(repoRoot, "tmp", "worktrees", "maxbuffer") },
    {
      execFileSyncImpl: (_command, _args, options) => {
        commandOptions = options;
        return porcelain;
      },
    },
  );
  assert.equal(commandOptions.maxBuffer, 10 * 1024 * 1024);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
  // The reason itself stays bounded at 50 paths and reports the actual remainder.
  const MAX_LISTED_DIRTY_PATHS = 50;
  const expectedRemainder = dirtyLineCount - MAX_LISTED_DIRTY_PATHS;
  assert.match(decision.reason, new RegExp(`… and ${expectedRemainder} more`));
});
