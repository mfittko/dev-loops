import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import extension from "../extension/index.ts";
import { DEV_LOOPS_ROLES } from "../extension/readonly-role-gate.ts";

// Issue #2965 AC1: the Pi `tool_call` handler applies the SAME Bash-gate deny decision as the
// Claude PreToolUse hook, for EVERY role — including the untagged main agent, which failed open
// before. Driven end to end through the real extension handler and the real fact resolution
// (`git`/`.devloops` reads go through the Pi `exec` double), never by calling the gate directly.

const SLUG = "acme/widgets";

/** A temp dir holding a `.devloops` repo config, i.e. a dev-loops-managed repo root. */
function managedRepoRoot({ humanMergeOnly = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-gate-"));
  // State the invariant explicitly: the shipped extension defaults resolve
  // `autonomy.humanMergeOnly: true` when a repo config omits the key, so an omission is NOT
  // "no human-merge invariant" (verified against packages/core/src/config/extension-defaults.yaml).
  fs.writeFileSync(path.join(root, ".devloops"), `version: 1\nautonomy:\n  humanMergeOnly: ${humanMergeOnly}\n`, "utf8");
  return root;
}

/**
 * Register the real extension on a Pi double whose `exec` answers the repo-identity, config and
 * draft-gate probes. Returns the `tool_call` handler, the recorded exec calls, and a mutable `state`
 * (flip `state.unmanaged` to make the same cwd become a repo between calls).
 */
function register({ repoRoot, slug = SLUG, unmanaged = false, readyGate = { code: 1, stderr: '{"error":"no clean draft_gate record"}' }, probeThrows = false } = {}) {
  const events = new Map();
  const execCalls = [];
  const state = { unmanaged: Boolean(unmanaged) };
  const exec = async (tool, args, opts) => {
    const command = args[args.length - 1];
    execCalls.push({ command, cwd: opts?.cwd });
    if (command === "git rev-parse --show-toplevel") {
      return state.unmanaged ? { code: 128, stdout: "", stderr: "not a git repository" } : { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    }
    if (command === "git config --get remote.origin.url") {
      return { code: 0, stdout: `https://github.com/${slug}.git\n`, stderr: "" };
    }
    if (command.includes("pre-pr-ready-gate.mjs")) {
      if (probeThrows) throw new Error("spawn node ENOENT");
      return { code: readyGate.code, stdout: "", stderr: readyGate.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  extension({ on: (event, handler) => events.set(event, handler), registerCommand() {}, exec });
  return { toolCall: events.get("tool_call"), execCalls, cwd: repoRoot, state };
}

const tag = (name) => `<active_agent name="${name}"/>`;

/** Call the handler as `role`: undefined = untagged main agent; otherwise the pi-subagents tag. */
function callAs(gate, role, command) {
  const ctx = role === undefined
    ? { cwd: gate.cwd, getSystemPrompt: () => "base prompt" }
    : { cwd: gate.cwd, getSystemPrompt: () => tag(role) };
  return gate.toolCall({ toolName: "bash", input: { command } }, ctx);
}

// Every role the Pi role seam can resolve: each roster role from `agents/*.agent.md`, the
// untagged main agent (`undefined`) and the fail-closed unresolved role (`''`).
const ALL_ROLES = [...DEV_LOOPS_ROLES, undefined, ""];

const MERGE = "gh pr merge 7 --squash";
const WAIVER_WRITE = "gh pr edit 7 --body 'adr-tripwire:allow standing waiver'";

// Captured at module load: the coordinator flag may be ambient (a coordinator-driven validation run),
// so clearing it for a test must restore it, never drop it for the rest of the process.
const ambientCoordinatorFlag = process.env.DEVLOOPS_COORDINATOR_READONLY;
function clearCoordinatorFlag() {
  delete process.env.DEVLOOPS_COORDINATOR_READONLY;
}
function restoreCoordinatorFlag() {
  if (ambientCoordinatorFlag === undefined) delete process.env.DEVLOOPS_COORDINATOR_READONLY;
  else process.env.DEVLOOPS_COORDINATOR_READONLY = ambientCoordinatorFlag;
}

test("Pi tool_call blocks a raw gh pr merge under humanMergeOnly for every role (STOP-HUMAN-MERGE-001)", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot({ humanMergeOnly: true }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, MERGE);
    assert.equal(decision.block, true, `role ${String(role)}: git push of a raw merge must be blocked`);
    assert.match(decision.reason, /STOP-HUMAN-MERGE-001/, `role ${String(role)}: reason must name the rule`);
  }
});

test("Pi tool_call blocks a raw waiver body write for every role (ADR-TRIPWIRE-STANDING-WAIVER)", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot({ humanMergeOnly: false }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, WAIVER_WRITE);
    assert.equal(decision.block, true, `role ${String(role)}: a raw waiver body write must be blocked`);
    assert.match(decision.reason, /ADR-TRIPWIRE-STANDING-WAIVER/, `role ${String(role)}: reason must name the rule`);
  }
});

test("Pi tool_call denies a raw gh pr merge outright even without the human-merge invariant (RAW-GH-PR-MERGE-BYPASS)", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot({ humanMergeOnly: false }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, MERGE);
    assert.equal(decision.block, true, `role ${String(role)}`);
    assert.match(decision.reason, /RAW-GH-PR-MERGE-BYPASS/, `role ${String(role)}: reason must name the rule`);
  }
});

test("Pi tool_call leaves the same commands alone outside a managed repo (the facts gate the decision)", async () => {
  clearCoordinatorFlag();
  const unmanaged = register({ repoRoot: managedRepoRoot(), unmanaged: true });
  assert.deepEqual(await callAs(unmanaged, undefined, MERGE), { block: false });
  assert.deepEqual(await callAs(unmanaged, "developer", MERGE), { block: false });
  // A raw merge that names a PROVEN-foreign repo is out of scope for the managed-repo deny. (The
  // Pi facts derive `managedRepoSlug` from the cwd repo, exactly as the Claude hook does, so a
  // managed context whose slug differs from the cwd repo cannot occur; the foreign-repo escape is
  // the reachable form of "the facts, not the command alone, decide".)
  const managed = register({ repoRoot: managedRepoRoot({ humanMergeOnly: false }) });
  assert.deepEqual(await callAs(managed, "developer", "gh pr merge --repo other/repo 7"), { block: false });
});

test("Pi tool_call surfaces the draft-gate probe's own error instead of \"no clean record\"", async () => {
  clearCoordinatorFlag();
  const failing = register({ repoRoot: managedRepoRoot() });
  const denied = await callAs(failing, undefined, "gh pr ready 7");
  assert.equal(denied.block, true);
  // The tool reported a reason on stderr: surface it, do not claim the evidence was absent.
  assert.match(denied.reason, /draft-gate evidence check failed \(no clean draft_gate record\)/);
  const probe = failing.execCalls.find((call) => call.command.includes("pre-pr-ready-gate.mjs"));
  assert.ok(probe, "the draft-gate probe must run for a managed-repo gh pr ready");
  assert.match(probe.command, new RegExp(`--repo ${SLUG} --pr 7$`));

  const passing = register({ repoRoot: managedRepoRoot(), readyGate: { code: 0 } });
  assert.deepEqual(await callAs(passing, undefined, "gh pr ready 7"), { block: false });
});

test("Pi tool_call still reports absent evidence when the probe exits non-zero with no reported error", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(), readyGate: { code: 1, stderr: "" } });
  assert.match((await callAs(gate, undefined, "gh pr ready 7")).reason, /no visible clean draft_gate/);
});

test("Pi tool_call reports \"could not run\" when the draft-gate probe cannot start", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(), probeThrows: true });
  const denied = await callAs(gate, undefined, "gh pr ready 7");
  assert.equal(denied.block, true);
  assert.match(denied.reason, /could not run scripts\/loop\/pre-pr-ready-gate\.mjs/);
});

test("Pi tool_call probes with the dev-loops package's own script, not the consumer repo's", async () => {
  clearCoordinatorFlag();
  const root = managedRepoRoot();
  assert.equal(fs.existsSync(path.join(root, "scripts")), false, "the fixture consumer repo ships no scripts/");
  const gate = register({ repoRoot: root, readyGate: { code: 0 } });
  assert.deepEqual(await callAs(gate, undefined, "gh pr ready 7"), { block: false });
  const probe = gate.execCalls.find((call) => call.command.includes("pre-pr-ready-gate.mjs"));
  assert.ok(probe, "the draft-gate probe must run for a managed-repo gh pr ready");
  const [bin, quotedPath] = probe.command.split(" ");
  const scriptPath = quotedPath.replace(/^"/, "").replace(/"$/, "");
  assert.equal(bin, "node", "the probe runs the script with node");
  assert.ok(path.isAbsolute(scriptPath), `probe script must be absolute, got ${scriptPath}`);
  assert.equal(fs.existsSync(scriptPath), true, "the probed script must exist in the dev-loops package");
  assert.equal(scriptPath.startsWith(root + path.sep), false, "the probe must not resolve inside the consumer repo");
  assert.equal(probe.cwd, root, "the probe still runs with the consumer repo as cwd");
});

test("Pi tool_call runs the draft-gate probe only for a gated gh pr ready", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot() });
  await callAs(gate, undefined, "gh pr view 7");
  assert.equal(gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")), false);
});

test("Pi tool_call caches the repo facts per cwd", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot({ humanMergeOnly: true }) });
  await callAs(gate, "developer", "git status");
  await callAs(gate, "developer", MERGE);
  const repoToplevel = gate.execCalls.filter((call) => call.command === "git rev-parse --show-toplevel");
  assert.equal(repoToplevel.length, 1, "repo identity must resolve once per cwd, not once per tool call");
});

test("Pi tool_call re-probes a cwd that was not a repo when it becomes one", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot({ humanMergeOnly: true }), unmanaged: true });
  // Not a repo yet: the facts stay permissive, and an unresolved cwd must NOT be cached as such.
  assert.deepEqual(await callAs(gate, "developer", MERGE), { block: false });
  gate.state.unmanaged = false;
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
});

test("Pi tool_call keeps STOP-HUMAN-MERGE-001 when the repo config layer is schema-rejected", async () => {
  clearCoordinatorFlag();
  const root = managedRepoRoot();
  // An unknown key makes the strict file schema reject the WHOLE `.devloops` layer, so the layer's
  // `humanMergeOnly: false` never applies and the packaged `autonomy.humanMergeOnly: true` default
  // still binds — the Claude edge's resolve-human-merge-only helper resolves true here too. Gating
  // the invariant on `errors.length === 0` would silently fail OPEN on exactly this case.
  fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: false\nunknownKnob: true\n", "utf8");
  const gate = register({ repoRoot: root });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, MERGE);
    assert.equal(decision.block, true, `role ${String(role)}`);
    assert.match(decision.reason, /STOP-HUMAN-MERGE-001/, `role ${String(role)}: a rejected repo layer must not drop the packaged default`);
  }
});

test("Pi tool_call revalidates the cached repo facts when the repo config changes (no stale facts)", async () => {
  clearCoordinatorFlag();
  const root = managedRepoRoot({ humanMergeOnly: false });
  const gate = register({ repoRoot: root });
  // Without the invariant a raw merge is still denied, by RAW-GH-PR-MERGE-BYPASS.
  assert.match((await callAs(gate, "developer", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
  // The same cwd turns the invariant on: a cached `humanMergeOnly: false` must not be served, or
  // the gate fails OPEN on exactly the rule this module closes.
  fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: true\n", "utf8");
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
});

test("Pi tool_call blocks the coordinator's inline verification under DEVLOOPS_COORDINATOR_READONLY=1", async () => {
  const gate = register({ repoRoot: managedRepoRoot() });
  process.env.DEVLOOPS_COORDINATOR_READONLY = "1";
  try {
    const denied = await callAs(gate, "dev-loop", "bun run verify");
    assert.equal(denied.block, true);
    assert.match(denied.reason, /COORDINATOR-VERIFY-BOUNDARY/);
    // A worker subagent may still run targeted checks inline.
    assert.deepEqual(await callAs(gate, "developer", "bun run verify"), { block: false });
  } finally {
    restoreCoordinatorFlag();
  }
});

test("Pi tool_call keeps the read-only role gate after the shared deny and never blocks other tools", async () => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot() });
  const judge = await callAs(gate, "judge", "bun run test");
  assert.equal(judge.block, true);
  assert.match(judge.reason, /Read-only role boundary/);
  assert.deepEqual(await callAs(gate, "judge", "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd"), { block: false });
  assert.deepEqual(await gate.toolCall({ toolName: "read", input: { path: "a" } }, { cwd: gate.cwd }), { block: false });
});
