import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DEVLOOPS_CONFIG_VARIANTS } from "@dev-loops/core/loop/bash-command-classify";
import extension from "../extension/index.ts";
import { DEV_LOOPS_ROLES, decidePiToolCall } from "../extension/readonly-role-gate.ts";
import { withTempDir } from "./_helpers.mjs";

// Issue #2965 AC1: the Pi `tool_call` handler applies the SAME Bash-gate deny decision as the
// Claude PreToolUse hook, for EVERY role — including the untagged main agent, which failed open
// before. Driven end to end through the real extension handler and the real fact resolution
// (`git`/`.devloops` reads go through the Pi `exec` double), never by calling the gate directly.

const SLUG = "acme/widgets";

let repoSeq = 0;
/** A `.devloops` repo root under the test's temp dir, i.e. a dev-loops-managed repo root. */
function managedRepoRoot(tmp, { humanMergeOnly = true } = {}) {
  const root = path.join(tmp, `repo-${(repoSeq += 1)}`);
  fs.mkdirSync(root);
  // State the invariant explicitly: the shipped extension defaults resolve
  // `autonomy.humanMergeOnly: true` when a repo config omits the key, so an omission is NOT
  // "no human-merge invariant" (verified against packages/core/src/config/extension-defaults.yaml).
  fs.writeFileSync(path.join(root, ".devloops"), `version: 1\nautonomy:\n  humanMergeOnly: ${humanMergeOnly}\n`, "utf8");
  return root;
}

/**
 * A `test()` whose repo fixtures live in one temp dir that is removed afterward (`withTempDir`) and
 * which restores the ambient coordinator flag afterwards: nearly every test clears it, so without a
 * per-test restore the file ends the process with the variable dropped and a later test file in the
 * same bun process sees a different environment than when it runs alone.
 */
const tempTest = (name, fn) =>
  test(name, () => withTempDir((tmp) => fn(tmp), { prefix: "pi-bash-gate-" }).finally(restoreCoordinatorFlag));

/**
 * Register the real extension on a Pi double whose `exec` answers the repo-identity, config and
 * draft-gate probes. Returns the `tool_call` handler, the recorded exec calls, and a mutable `state`
 * (flip `state.unmanaged` to make the same cwd become a repo between calls).
 */
function register({
  repoRoot,
  slug = SLUG,
  unmanaged = false,
  readyGate = { code: 1, stderr: '{"error":"no clean draft_gate record"}' },
  probeThrows = false,
  probeKilled = false,
} = {}) {
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
      // `killed` is how the exec seam reports the probe's own timeout (`PR_READY_GATE_TIMEOUT_MS`).
      return { code: readyGate.code, stdout: "", stderr: readyGate.stderr ?? "", killed: probeKilled };
    }
    // FAIL CLOSED on anything else: a generic success let fact resolution grow a call (an extra git
    // read, a second probe) with every test in this file still passing.
    throw new Error(`unexpected exec: ${command}`);
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

tempTest("Pi tool_call blocks a raw gh pr merge under humanMergeOnly for every role (STOP-HUMAN-MERGE-001)", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: true }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, MERGE);
    assert.equal(decision.block, true, `role ${String(role)}: a raw merge must be blocked`);
    assert.match(decision.reason, /STOP-HUMAN-MERGE-001/, `role ${String(role)}: reason must name the rule`);
  }
});

tempTest("Pi tool_call blocks a raw waiver body write for every role (ADR-TRIPWIRE-STANDING-WAIVER)", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, WAIVER_WRITE);
    assert.equal(decision.block, true, `role ${String(role)}: a raw waiver body write must be blocked`);
    assert.match(decision.reason, /ADR-TRIPWIRE-STANDING-WAIVER/, `role ${String(role)}: reason must name the rule`);
  }
});

tempTest("Pi tool_call denies a raw gh pr merge outright even without the human-merge invariant (RAW-GH-PR-MERGE-BYPASS)", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  for (const role of ALL_ROLES) {
    const decision = await callAs(gate, role, MERGE);
    assert.equal(decision.block, true, `role ${String(role)}`);
    assert.match(decision.reason, /RAW-GH-PR-MERGE-BYPASS/, `role ${String(role)}: reason must name the rule`);
  }
});

tempTest("Pi tool_call leaves the same commands alone outside a managed repo (the facts gate the decision)", async (tmp) => {
  clearCoordinatorFlag();
  const unmanaged = register({ repoRoot: managedRepoRoot(tmp), unmanaged: true });
  assert.deepEqual(await callAs(unmanaged, undefined, MERGE), { block: false });
  assert.deepEqual(await callAs(unmanaged, "developer", MERGE), { block: false });
  // A raw merge that names a PROVEN-foreign repo is out of scope for the managed-repo deny. (The
  // Pi facts derive `managedRepoSlug` from the cwd repo, exactly as the Claude hook does, so a
  // managed context whose slug differs from the cwd repo cannot occur; the foreign-repo escape is
  // the reachable form of "the facts, not the command alone, decide".)
  const managed = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  assert.deepEqual(await callAs(managed, "developer", "gh pr merge --repo other/repo 7"), { block: false });
});

tempTest("Pi tool_call surfaces the draft-gate probe's own error instead of \"no clean record\"", async (tmp) => {
  clearCoordinatorFlag();
  const failing = register({ repoRoot: managedRepoRoot(tmp) });
  const denied = await callAs(failing, undefined, "gh pr ready 7");
  assert.equal(denied.block, true);
  // The tool reported a reason on stderr: surface it, do not claim the evidence was absent.
  assert.match(denied.reason, /draft-gate evidence check failed \(no clean draft_gate record\)/);
  const probe = failing.execCalls.find((call) => call.command.includes("pre-pr-ready-gate.mjs"));
  assert.ok(probe, "the draft-gate probe must run for a managed-repo gh pr ready");
  assert.match(probe.command, new RegExp(`--repo ${SLUG} --pr 7$`));

  const passing = register({ repoRoot: managedRepoRoot(tmp), readyGate: { code: 0 } });
  assert.deepEqual(await callAs(passing, undefined, "gh pr ready 7"), { block: false });
});

tempTest("Pi tool_call still reports absent evidence when the probe exits non-zero with no reported error", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp), readyGate: { code: 1, stderr: "" } });
  assert.match((await callAs(gate, undefined, "gh pr ready 7")).reason, /no visible clean draft_gate/);
});

tempTest("Pi tool_call reports \"could not run\" when the draft-gate probe cannot start", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp), probeThrows: true });
  const denied = await callAs(gate, undefined, "gh pr ready 7");
  assert.equal(denied.block, true);
  assert.match(denied.reason, /could not run scripts\/loop\/pre-pr-ready-gate\.mjs/);
});

tempTest("Pi tool_call reports \"could not run\" for a probe timeout and a node startup failure", async (tmp) => {
  clearCoordinatorFlag();
  // A probe killed at its timeout never reported evidence: deny as "could not run", never as
  // "no clean draft_gate record" (a killed child carries a null exit code and empty stderr).
  const timedOut = register({ repoRoot: managedRepoRoot(tmp), probeKilled: true, readyGate: { code: null, stderr: "" } });
  const killed = await callAs(timedOut, undefined, "gh pr ready 7");
  assert.equal(killed.block, true);
  assert.match(killed.reason, /could not run scripts\/loop\/pre-pr-ready-gate\.mjs/);
  // Node's own startup diagnostic (missing module) means the gate script never ran either.
  const startupFailure = register({
    repoRoot: managedRepoRoot(tmp),
    readyGate: { code: 1, stderr: "Error: Cannot find module '/opt/dev-loops/scripts/loop/pre-pr-ready-gate.mjs'" },
  });
  const notRun = await callAs(startupFailure, undefined, "gh pr ready 7");
  assert.equal(notRun.block, true);
  assert.match(notRun.reason, /could not run scripts\/loop\/pre-pr-ready-gate\.mjs/);
});

tempTest("Pi tool_call probes with the dev-loops package's own script, not the consumer repo's", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp);
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

tempTest("Pi tool_call runs the draft-gate probe only for a gated gh pr ready", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
  await callAs(gate, undefined, "gh pr view 7");
  assert.equal(gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")), false);
});

tempTest("Pi tool_call caches the repo facts per cwd", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: true }) });
  await callAs(gate, "developer", "git status");
  await callAs(gate, "developer", MERGE);
  const repoToplevel = gate.execCalls.filter((call) => call.command === "git rev-parse --show-toplevel");
  assert.equal(repoToplevel.length, 1, "repo identity must resolve once per cwd, not once per tool call");
  // The FULL sequence, in order: fact resolution must not grow a call (an extra git read, a second
  // probe) without a test failing — neither command carries a ready verb, so no probe belongs here.
  assert.deepEqual(
    gate.execCalls.map((call) => call.command),
    ["git rev-parse --show-toplevel", "git config --get remote.origin.url"],
  );
});

tempTest("Pi tool_call re-probes a cwd that was not a repo when it becomes one", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: true }), unmanaged: true });
  // Not a repo yet: the facts stay permissive, and an unresolved cwd must NOT be cached as such.
  assert.deepEqual(await callAs(gate, "developer", MERGE), { block: false });
  gate.state.unmanaged = false;
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
});

tempTest("Pi tool_call keeps STOP-HUMAN-MERGE-001 when the repo config layer is schema-rejected", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp);
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

tempTest("Pi tool_call revalidates the cached repo facts when the repo config changes (no stale facts)", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp, { humanMergeOnly: false });
  const gate = register({ repoRoot: root });
  // Without the invariant a raw merge is still denied, by RAW-GH-PR-MERGE-BYPASS.
  assert.match((await callAs(gate, "developer", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
  // The same cwd turns the invariant on: a cached `humanMergeOnly: false` must not be served, or
  // the gate fails OPEN on exactly the rule this module closes.
  fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: true\n", "utf8");
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
});

tempTest("Pi tool_call blocks the coordinator's inline verification under DEVLOOPS_COORDINATOR_READONLY=1", async (tmp) => {
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
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

tempTest("Pi tool_call keeps the read-only role gate for non-read commands and never blocks other tools", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
  const judge = await callAs(gate, "judge", "bun run test");
  assert.equal(judge.block, true);
  assert.match(judge.reason, /Read-only role boundary/);
  assert.deepEqual(await callAs(gate, "judge", "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd"), { block: false });
  assert.deepEqual(await gate.toolCall({ toolName: "read", input: { path: "a" } }, { cwd: gate.cwd }), { block: false });
});

tempTest("Pi tool_call keeps the untagged main-agent external-write path and denies the unresolved role", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
  const create = "gh issue create --title x --body y";
  // The external-write deny is subagent-scoped: the untagged main agent is the operator path and
  // must stay allowed, the one guard against an over-blocking role-mapping change.
  assert.deepEqual(await callAs(gate, undefined, create), { block: false });
  // The unresolved role ('') is treated as a subagent context, so the same write is denied.
  const unresolved = await callAs(gate, "", create);
  assert.equal(unresolved.block, true, "the unresolved role must fail closed on an external write");
  assert.match(unresolved.reason, /Ad-hoc GitHub issue\/PR creation/);
});

tempTest("Pi tool_call keeps a reviewer's quoted read form whose text spells a merge verb", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  // The reviewer read form the cross-harness contract names: every word is fully single quoted, so
  // the command only greps. The segment classifiers split shell text without quote awareness, so the
  // role's read/search allow has to be decided before the shared deny to keep it reachable.
  assert.deepEqual(await callAs(gate, "review", "grep '; gh pr merge 42 ;' README.md"), { block: false });
  // A real merge from the same role is still denied by the shared deny, and a non-read command by
  // the role gate: the allow covers read/search forms only.
  assert.match((await callAs(gate, "review", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
  assert.match((await callAs(gate, "review", "bun test")).reason, /Read-only role boundary/);
});

tempTest("Pi tool_call skips the draft-gate probe for a gh pr ready that is proven foreign", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
  // Every ready segment carries an explicit foreign repo, so the shared decider allows the command
  // through its proven-foreign escape and never reads the probe result: do not spend a spawn (bounded
  // by PR_READY_GATE_TIMEOUT_MS) on it.
  assert.deepEqual(await callAs(gate, undefined, "gh pr ready --repo other/repo 7"), { block: false });
  assert.equal(
    gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")),
    false,
    "a proven-foreign ready must not be probed",
  );
  // An in-scope ready still probes (and denies on a failing probe), including the managed slug form.
  assert.match((await callAs(gate, undefined, `gh pr ready --repo ${SLUG} 7`)).reason, /draft-gate evidence check failed/);
  assert.match((await callAs(gate, undefined, "gh pr ready 7")).reason, /draft-gate evidence check failed/);
  assert.ok(gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")), "an in-scope ready must be probed");
});

tempTest("Pi tool_call revalidates the cached facts when any .devloops variant in the core list appears", async (tmp) => {
  clearCoordinatorFlag();
  // The signature covers the core `DEVLOOPS_CONFIG_VARIANTS` list, not a local copy of it: a variant
  // added there (or a config file appearing mid-session) must invalidate the cache for this cwd.
  for (const ext of DEVLOOPS_CONFIG_VARIANTS) {
    const root = path.join(tmp, `variant${ext ? `-${ext.slice(1)}` : ""}-${(repoSeq += 1)}`);
    fs.mkdirSync(root);
    const gate = register({ repoRoot: root });
    // No config yet: a git repo, but not dev-loops-managed, so a raw merge is allowed and cached.
    assert.deepEqual(await callAs(gate, "developer", MERGE), { block: false }, `variant ${ext || "(bare)"}: no config yet`);
    fs.writeFileSync(path.join(root, `.devloops${ext}`), "version: 1\nautonomy:\n  humanMergeOnly: true\n", "utf8");
    assert.match(
      (await callAs(gate, "developer", MERGE)).reason,
      /STOP-HUMAN-MERGE-001/,
      `variant ${ext || "(bare)"} must invalidate the cached facts`,
    );
  }
});

tempTest("Pi tool_call re-reads the config after a same-size rewrite inside one timestamp tick", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp, { humanMergeOnly: false });
  const file = path.join(root, ".devloops");
  // Equal byte length on purpose: a stat-only signature (mtimeMs/size/ino) cannot see the swap.
  const off = "version: 1\nautonomy:\n  humanMergeOnly: false\n# pad: 123456\n";
  const on = "version: 1\nautonomy:\n  humanMergeOnly: true\n# pad: 1234567\n";
  assert.equal(off.length, on.length, "the fixture must be a same-size rewrite");
  fs.writeFileSync(file, off, "utf8");
  const gate = register({ repoRoot: root });
  assert.match((await callAs(gate, "developer", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
  const before = fs.statSync(file);
  fs.writeFileSync(file, on, "utf8");
  // Pin the timestamps so only the content differs: the cache must still notice.
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, off.length, "the rewrite must keep the size");
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
});

test("decidePiToolCall fails closed when the caller injects no facts", () => {
  // The seam has no empty-facts default: omitting the injection used to switch every shared deny
  // rule off and leave only the read-only role restriction — the fail-open this module closes.
  const decision = decidePiToolCall({ toolName: "bash", input: { command: MERGE }, agentType: null });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /resolved no repo facts/);
  // Neither a non-bash tool nor a reviewer's read/search form needs facts.
  assert.deepEqual(decidePiToolCall({ toolName: "read", input: { path: "a" }, agentType: null }), { block: false });
  assert.deepEqual(decidePiToolCall({ toolName: "bash", input: { command: "grep -n foo x" }, agentType: "review" }), { block: false });
});

test("the file leaves the ambient DEVLOOPS_COORDINATOR_READONLY value for later test files", () => {
  // Declared last on purpose: every test above clears the flag, so a run that exported it must end
  // this file with the value it started with or later files in the same bun process run differently.
  assert.equal(process.env.DEVLOOPS_COORDINATOR_READONLY, ambientCoordinatorFlag);
});
