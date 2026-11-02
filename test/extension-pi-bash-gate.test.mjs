import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE_VARIANTS } from "@dev-loops/core/config";
import extension from "../extension/index.ts";
import { createPiBashGateFactsResolver } from "../extension/bash-gate-facts.ts";
import { DEV_LOOPS_ROLES, decidePiToolCall } from "../extension/readonly-role-gate.ts";
import { withTempDir } from "./_helpers.mjs";

// Issue #2965 AC1: the Pi `tool_call` handler applies the SAME Bash-gate deny decision as the
// Claude PreToolUse hook, for EVERY role — including the untagged main agent, which failed open
// before. Driven end to end through the real extension handler and the real fact resolution
// (`git`/`.devloops` reads go through the Pi `exec` double), never by calling the gate directly.

const SLUG = "acme/widgets";
/** The repository root, for the source-level derivation assertions (the loader's one variant list). */
const SOURCE_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The identity probe's exact command. `LC_ALL=C` is load-bearing, not incidental: see the locale
 * test below, which fails if the pin is ever dropped.
 */
const PROBE_COMMAND = "LC_ALL=C git rev-parse --show-toplevel";
/** Git's own definitive "not a git repository" sentence — the matcher's ACCEPTED input form. */
const NOT_A_REPO_EN = "fatal: not a git repository (or any of the parent directories): .git";
/** The same sentence from an NLS git under a non-English locale — the matcher's REJECTED input form. */
const NOT_A_REPO_DE = "fatal: Kein Git-Repository (oder irgendein übergeordnetes Verzeichnis): .git";

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
 * describing what the NEXT identity read answers: flip `state.unmanaged` to make the same cwd become
 * a repo between calls, move `state.repoRoot` to make it resolve to a different root (a repo created
 * below the cached one, or the cwd itself after `git init`), change `state.slug` for a changed
 * origin, or set `state.remoteDown` for a remote lookup that fails.
 */
function register({
  repoRoot,
  slug = SLUG,
  unmanaged = false,
  /*
   * How the repo IDENTITY probe answers, beyond the happy path: `noisy` appends a login-shell banner
   * to `--show-toplevel` stdout, `killed` reports the 5s cap firing, `throws` rejects the exec. All
   * three are UNKNOWN outcomes (the Pi adapter fails closed); `unmanaged` above is git's DEFINITIVE
   * "not a repository" answer, which stays permissive.
   */
  toplevel = 'ok',
  readyGate = { code: 1, stderr: '{"error":"no clean draft_gate record"}' },
  probeThrows = false,
  probeKilled = false,
  /*
   * Runs INSIDE the remote-URL lookup, i.e. after the probe's own `.devloops` presence read and
   * before that lookup returns. It models a writer that creates a config file in exactly the window
   * the probe's `inManagedContext` cannot see and a signature read afterwards can.
   */
  remoteLookup = null,
  /*
   * An NLS git built with gettext prints git's "not a git repository" sentence TRANSLATED under a
   * non-English locale. `'host'` models that host: the German line for the UNPINNED probe form, so a
   * fixture asserting the permissive `not-a-repo` facts passes only while the probe pins its locale.
   * `'always'` hands the German line over even to the pinned probe, so the matcher's REJECTED input
   * form reaches the classifier directly and must fail closed.
   */
  localizedNotARepo = false,
} = {}) {
  const events = new Map();
  const execCalls = [];
  const state = { unmanaged: Boolean(unmanaged), repoRoot: null, slug: null, remoteDown: false };
  const exec = async (tool, args, opts) => {
    const command = args[args.length - 1];
    execCalls.push({ command, cwd: opts?.cwd });
    if (localizedNotARepo && command === "git rev-parse --show-toplevel") {
      return { code: 128, stdout: "", stderr: NOT_A_REPO_DE };
    }
    if (command === PROBE_COMMAND) {
      if (state.unmanaged) return { code: 128, stdout: "", stderr: localizedNotARepo === "always" ? NOT_A_REPO_DE : NOT_A_REPO_EN };
      if (toplevel === "throws") throw new Error("spawn git ENOENT");
      if (toplevel === "killed") return { code: null, stdout: "", stderr: "", killed: true };
      if (toplevel === "noisy") return { code: 0, stdout: `profile banner written by .zprofile\n${repoRoot}\n`, stderr: "" };
      return { code: 0, stdout: `${state.repoRoot ?? repoRoot}\n`, stderr: "" };
    }
    if (command === "git config --get remote.origin.url") {
      if (remoteLookup) remoteLookup();
      if (state.remoteDown) return { code: 128, stdout: "", stderr: "" };
      return { code: 0, stdout: `https://github.com/${state.slug ?? slug}.git\n`, stderr: "" };
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

// The repo identity probe is the ONE fact that can switch every managed-repo deny off at once. The
// Pi `exec` seam runs through `bash -lc` with a 5s cap, so unlike the Claude edge's `execFileSync`
// (no login shell, no cap) it can fail: a killed probe leaves `repoRoot` null, and a login-shell
// banner makes it non-single-line. Neither may be read as "not a managed repo" — that fails OPEN on
// STOP-HUMAN-MERGE-001 and ADR-TRIPWIRE-STANDING-WAIVER for the rest of the session. An UNKNOWN
// outcome therefore gates on the config layer at or above the cwd (identity unresolved, so the
// slug-scoped rules still fail closed) and is never cached. `unmanaged` above is git's DEFINITIVE
// "not a repository" answer and stays permissive, matching Claude.
tempTest("Pi tool_call fails CLOSED when the repo identity probe cannot answer (killed, noisy, thrown)", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp, { humanMergeOnly: true });
  for (const toplevel of ["killed", "noisy", "throws"]) {
    const gate = register({ repoRoot: root, toplevel });
    for (const role of [undefined, "developer"]) {
      const merge = await callAs(gate, role, MERGE);
      assert.equal(merge.block, true, `${toplevel} / ${String(role)}: a raw merge must stay denied`);
      assert.match(merge.reason, /STOP-HUMAN-MERGE-001|RAW-GH-PR-MERGE-BYPASS/, toplevel);
      const waiver = await callAs(gate, role, WAIVER_WRITE);
      assert.match(waiver.reason, /ADR-TRIPWIRE-STANDING-WAIVER/, `${toplevel} / ${String(role)}: the waiver write must stay denied`);
    }
    // Never cached: the next call asks git again instead of serving a degraded answer all session.
    const probes = () => gate.execCalls.filter((call) => call.command === PROBE_COMMAND).length;
    const before = probes();
    await callAs(gate, "developer", MERGE);
    assert.equal(probes(), before + 1, `${toplevel}: an unknown probe must be re-probed, not cached`);
  }
});

// The probe's definitive negative is git's own sentence, which git emits through gettext: an NLS
// build under a non-English locale prints a TRANSLATED line instead, `NOT_A_REPO_RE` misses it, and
// the definitive answer degrades to `unknown` — the same cwd+command is then denied on Pi while the
// Claude edge, which reads whatever the host printed, allows it. The fix pins the LOCALE, not the
// text, so the probe's answer depends on repo state instead of on the machine. The fixture models
// the NLS host and hands the translated line over for the UNPINNED probe form only, so dropping the
// pin flips the classification to the fail-closed branch and fails the assertion below.
tempTest("Pi tool_call pins the identity probe's locale so a localized not-a-repository line cannot flip the verdict", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp, { humanMergeOnly: true });
  // ACCEPTED form: git's definitive English sentence stays permissive. The fixture is an NLS host,
  // so this passes only while the probe pins its own locale instead of reading the host's output.
  const nlsHost = register({ repoRoot: root, unmanaged: true, localizedNotARepo: "host" });
  assert.deepEqual(
    await callAs(nlsHost, undefined, MERGE),
    { block: false },
    `${NOT_A_REPO_EN} is git's DEFINITIVE negative and must stay permissive, whatever the host locale would print`,
  );
  assert.equal(
    nlsHost.execCalls[0].command,
    PROBE_COMMAND,
    "the identity probe must pin LC_ALL=C so the machine locale cannot reach the classification",
  );
  assert.equal(
    nlsHost.execCalls.some((call) => call.command === "git rev-parse --show-toplevel"),
    false,
    "no classification may ever be derived from the unpinned (localized) probe form",
  );
  // REJECTED form: the translated sentence is not git's definitive answer, so it must never be read
  // as the permissive `not-a-repo` outcome — the managed-repo denies stay armed (fail closed).
  const translated = register({ repoRoot: root, unmanaged: true, localizedNotARepo: "always" });
  const armed = await callAs(translated, undefined, MERGE);
  assert.equal(armed.block, true, "a translated not-a-repository line must never be read as the permissive answer");
  assert.match(armed.reason, /STOP-HUMAN-MERGE-001|RAW-GH-PR-MERGE-BYPASS/);
});

// The tri-state identity fact is TOTAL: ONLY git's explicit `not-a-repo` answer is permissive. A
// repo context wired through the injectable seam (`createPostMergeUpdateHook`'s stubs already return
// `{ repoRoot, repoSlug, inManagedContext }`) carries NO `identityProbe` tag, and reading that
// absence as "not a repository" is the fail-open this module exists to close: `repoRoot` becomes
// null, EMPTY_REPO_FACTS comes back, and STOP-HUMAN-MERGE-001, RAW-GH-PR-MERGE-BYPASS,
// WORKTREE-NO-STASH and the tripwire waiver deny all switch off.
tempTest("Pi facts treat a repo context with no identityProbe tag as UNKNOWN, never as not-a-repo", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp, { humanMergeOnly: true });
  const resolveFacts = createPiBashGateFactsResolver({
    exec: async () => {
      throw new Error("the injected repo context must be used instead of exec");
    },
    env: {},
    resolveRepoContext: async () => ({ repoRoot: root, repoSlug: SLUG, inManagedContext: false }),
  });
  const facts = await resolveFacts({ cwd: root, command: MERGE });
  assert.equal(facts.inManagedContext, true, "an untagged context degrades to the managed walk (fail closed)");
  assert.equal(facts.managedRepoSlug, null, "the identity stays unresolved, so every slug-scoped rule fails closed");
  const decision = decidePiToolCall({ toolName: "bash", input: { command: MERGE }, agentType: null, facts });
  assert.equal(decision.block, true, "the managed-repo denies must stay armed for an untagged context");
  assert.match(decision.reason, /STOP-HUMAN-MERGE-001|RAW-GH-PR-MERGE-BYPASS/);
});

// Issue 2577's owner allowlist keys on the ROLE name alone, which Pi resolves from `active_agent`, so
// it belongs in the shared deny set: kept at the Claude edge it denied on Claude Code while a Pi
// fixer/developer/quality/gate-coordinator child ran the same script.
tempTest("Pi tool_call enforces the unresolve owner allowlist for every role (issue 2577)", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  const command = "dev-loops-run scripts/github/unresolve-review-thread.mjs --repo acme/widgets --pr 7 --thread-id T1";
  for (const role of [undefined, "dev-loop"]) {
    assert.equal((await callAs(gate, role, command)).block, false, `${String(role)} owns the script`);
  }
  for (const role of ["fixer", "developer", "quality", "docs", "review", "gate-coordinator", ""]) {
    const decision = await callAs(gate, role, command);
    assert.equal(decision.block, true, `${String(role)} must not reopen a resolved thread`);
    assert.match(decision.reason, /unresolve-review-thread\.mjs/, `${String(role)}: the deny names the script`);
  }
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

tempTest("Pi tool_call denies an unscopable gh pr ready instead of probing with a junk scope", async (tmp) => {
  clearCoordinatorFlag();
  // The fail-closed half of the probe: with no PR number, or with a remote whose slug is not a clean
  // owner/name identity, the guard cannot scope `pre-pr-ready-gate.mjs`. Deny with the decider's own
  // message — never spawn the probe with a bogus `--repo`/`--pr`, and never skip the guard.
  const noNumber = register({ repoRoot: managedRepoRoot(tmp) });
  const bare = await callAs(noNumber, undefined, "gh pr ready");
  assert.equal(bare.block, true, "a ready verb carrying no PR number must be denied");
  assert.match(bare.reason, /could not determine the PR number/);

  const hostileSlug = register({ repoRoot: managedRepoRoot(tmp), slug: "acme/widgets;id" });
  const hostile = await callAs(hostileSlug, undefined, "gh pr ready 7");
  assert.equal(hostile.block, true, "a remote whose slug fails isCleanRepoSlug must be denied");
  assert.match(hostile.reason, /no visible clean draft_gate/);

  for (const [label, gate] of [["no PR number", noNumber], ["hostile slug", hostileSlug]]) {
    assert.equal(
      gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")),
      false,
      `${label}: the unscopable ready must not spawn the draft-gate probe`,
    );
  }
});

tempTest("Pi tool_call probes the IN-SCOPE gh pr ready target, not the command's first ready segment", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp) });
  // The command-wide reading takes the PR number from the segment that carries the repo flag — here
  // the PROVEN-FOREIGN `other/repo 7`. Probing that and applying the answer to the command authorized
  // a different, in-scope PR that had no evidence of its own (#2965 review).
  const denied = await callAs(gate, "developer", "gh pr ready --repo other/repo 7 && gh pr ready 8");
  const probe = gate.execCalls.find((call) => call.command.includes("pre-pr-ready-gate.mjs"));
  assert.ok(probe, "the in-scope ready target must be probed");
  assert.match(probe.command, new RegExp(`--repo ${SLUG} --pr 8$`), "the probe must check the in-scope PR");
  assert.equal(denied.block, true);
  assert.match(denied.reason, /draft-gate evidence check failed/);
});

tempTest("Pi tool_call denies a gh pr ready naming several in-scope PRs without spending the probe", async (tmp) => {
  clearCoordinatorFlag();
  // `readyGate` is ONE fact about ONE probed PR, and the shared decision authorizes every ready
  // segment in the command from it: no single probe can answer for two in-scope targets, and PR #7's
  // clean record must never clear #8's draft status. Deny before the probe — the answer is not the
  // fact that is missing here.
  const gate = register({ repoRoot: managedRepoRoot(tmp), readyGate: { code: 0 } });
  const decision = await callAs(gate, "developer", "gh pr ready 7 && gh pr ready 8");
  assert.equal(decision.block, true);
  assert.match(decision.reason, /GATE-COMMENT-DRAFT-REQUIREMENTS/);
  assert.match(decision.reason, /probed for exactly ONE PR/);
  assert.equal(
    gate.execCalls.some((call) => call.command.includes("pre-pr-ready-gate.mjs")),
    false,
    "neither PR's evidence can authorize the other, so the probe is not the fact to gather",
  );
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

tempTest("Pi tool_call caches the repo facts per cwd and revalidates the git identity on every call", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: true }) });
  await callAs(gate, "developer", "git status");
  await callAs(gate, "developer", MERGE);
  // The git IDENTITY is re-read on EVERY call, deliberately: a cached slug that no longer matches the
  // repo makes an in-scope body write read as PROVEN FOREIGN, and a managed repo created below a
  // cached unmanaged root leaves every managed-repo deny switched off — neither is visible in the
  // config-source signature, so this cheap local re-probe is what keeps the entry honest. What stays
  // cached is the expensive half: the merged config load behind those facts.
  const repoToplevel = gate.execCalls.filter((call) => call.command === PROBE_COMMAND);
  assert.equal(repoToplevel.length, 2, "the identity probe answers once per tool call");
  // The FULL sequence, in order: fact resolution must not grow a call (an extra git read, a second
  // probe) without a test failing — neither command carries a ready verb, so no probe belongs here.
  assert.deepEqual(
    gate.execCalls.map((call) => call.command),
    [PROBE_COMMAND, "git config --get remote.origin.url", PROBE_COMMAND, "git config --get remote.origin.url"],
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

tempTest("Pi tool_call re-reads the facts when a config file appears during the identity lookup (no fail-open cache entry)", async (tmp) => {
  clearCoordinatorFlag();
  // The probe reads `.devloops` presence itself, BEFORE its remote-URL lookup, while the cache
  // signature used to be taken only after every read. A `.devloops` created in between was therefore
  // hashed into the entry as PRESENT while the facts still said `inManagedContext: false`, and that
  // fresh digest vouched for the permissive answer on every later call: raw merges and body writes
  // stayed allowed in a now-managed checkout until a config source changed again.
  const root = path.join(tmp, `lookup-race-${(repoSeq += 1)}`);
  fs.mkdirSync(root);
  const gate = register({
    repoRoot: root,
    remoteLookup: () => fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: true\n", "utf8"),
  });
  assert.match(
    (await callAs(gate, "developer", MERGE)).reason,
    /STOP-HUMAN-MERGE-001/,
    "the read must settle on the managed answer the sources now report, not the stale unmanaged one",
  );
  // And the settled answer is served, not re-derived: the next call costs ONE identity revalidation
  // probe (the per-call git read the cache above pins) and no retry loop, because the settled facts
  // and the sources agree — a second read would show up here as a third probe.
  const probes = () => gate.execCalls.filter((call) => call.command === PROBE_COMMAND).length;
  const before = probes();
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/, "the settled answer must be served next call");
  assert.equal(probes(), before + 1, "the settled answer must be served after one revalidation, not re-derived");
});

tempTest("Pi tool_call revalidates the cached slug when the repo's origin changes (no stale foreign escape)", async (tmp) => {
  clearCoordinatorFlag();
  const gate = register({ repoRoot: managedRepoRoot(tmp, { humanMergeOnly: false }) });
  assert.match((await callAs(gate, "developer", WAIVER_WRITE)).reason, /ADR-TRIPWIRE-STANDING-WAIVER/);
  // The origin changes under the same cwd (a renamed remote, a fresh clone over the same path). A
  // body write to the repo the cwd is ACTUALLY in must stay denied: a cached `acme/widgets` made the
  // new `fork/renamed` target read as a PROVEN-FOREIGN repo, which switched the tripwire waiver deny
  // off for the rest of the session while the config sources were untouched.
  gate.state.slug = "fork/renamed";
  const denied = await callAs(gate, "developer", "gh pr edit 7 --repo fork/renamed --body 'adr-tripwire:allow standing waiver'");
  assert.equal(denied.block, true);
  assert.match(denied.reason, /ADR-TRIPWIRE-STANDING-WAIVER/);
});

tempTest("Pi tool_call re-reads the facts when a managed repo appears below the cached unmanaged root", async (tmp) => {
  clearCoordinatorFlag();
  const ancestor = path.join(tmp, `nested-${(repoSeq += 1)}`);
  const nested = path.join(ancestor, "sub");
  fs.mkdirSync(nested, { recursive: true });
  // The cwd is `nested`, but its first identity answer is the UNMANAGED ancestor above it (no
  // `.devloops` there), and those facts are cached under `nested` — keyed to the ANCESTOR's config
  // sources. Deliberately NOT a git repo fixture: only the resolved root and the managed-context
  // answer move, which is exactly what the config-source signature cannot see.
  const gate = register({ repoRoot: nested });
  gate.state.repoRoot = ancestor;
  assert.deepEqual(await callAs(gate, "developer", MERGE), { block: false }, "an unmanaged checkout stays unrestricted");
  // A dev-loops-managed repo is created BELOW that cached root. Nothing in the ancestor changes, so
  // the signature keeps matching while the cwd is now a managed checkout: serving the cached
  // `inManagedContext: false` left RAW-GH-PR-MERGE-BYPASS and STOP-HUMAN-MERGE-001 switched off.
  fs.writeFileSync(path.join(nested, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: false\n", "utf8");
  gate.state.repoRoot = nested;
  assert.match((await callAs(gate, "developer", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
});

tempTest("Pi tool_call recovers the repo identity after a transient remote lookup failure", async (tmp) => {
  clearCoordinatorFlag();
  const root = managedRepoRoot(tmp);
  const gate = register({ repoRoot: root, readyGate: { code: 0 }, });
  gate.state.remoteDown = true;
  // The remote lookup fails once. The facts stay fail-closed (a managed context whose slug cannot be
  // resolved still gates), so no probe is spawned with a junk scope — and this entry must not pin the
  // session: a cached `repoSlug: null` used to keep the ready verb denied for good, because nothing in
  // the config sources ever changed to invalidate it.
  const unresolved = await callAs(gate, "developer", "gh pr ready 7");
  assert.equal(unresolved.block, true, "an unresolved slug must fail closed");
  assert.match(unresolved.reason, /no visible clean draft_gate/);
  gate.state.remoteDown = false;
  assert.deepEqual(
    await callAs(gate, "developer", "gh pr ready 7"),
    { block: false },
    "the resolved slug must be re-read, not served from the cached null-slug entry",
  );
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
  // BOTH halves read the config loader's own `CONFIG_FILE_VARIANTS` list, not a local copy of it: the
  // deny below needs the presence probe to see `.devloops<variant>` (else `inManagedContext` stays
  // false) AND the signature to invalidate the cached pre-file facts (else the permissive entry is
  // served). A variant added to the canonical list must therefore satisfy both with no second edit.
  for (const ext of CONFIG_FILE_VARIANTS) {
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

tempTest("Pi facts read the loader's ONE canonical variant list, for the probe and the signature alike", async (tmp) => {
  clearCoordinatorFlag();
  // Two hand-kept variant lists split the halves of one fact set: a variant added to the loader's
  // `CONFIG_FILE_VARIANTS` alone left the presence probe reporting `inManagedContext: false` (every
  // managed-repo deny off) while the cache signature tracked it. Pin the single derivation: both
  // halves read the loader's exported list, and neither keeps a second copy of it.
  const sources = {
    "extension/post-merge-update.ts": fs.readFileSync(path.join(SOURCE_ROOT, "extension/post-merge-update.ts"), "utf8"),
    "extension/bash-gate-facts.ts": fs.readFileSync(path.join(SOURCE_ROOT, "extension/bash-gate-facts.ts"), "utf8"),
  };
  for (const [file, source] of Object.entries(sources)) {
    assert.match(source, /CONFIG_FILE_VARIANTS/, `${file} must derive from the loader's canonical list`);
    assert.equal(
      /\[\s*""\s*,\s*"\.yaml"\s*,\s*"\.yml"\s*,\s*"\.json"\s*\]/.test(source),
      false,
      `${file} must not keep a second, hand-kept copy of the variant list`,
    );
  }
  assert.match(
    sources["extension/post-merge-update.ts"],
    /CONFIG_FILE_VARIANTS\.some\(\(ext\) => fs\.existsSync\(path\.join\(repoRoot, `\.devloops\$\{ext\}`\)\)\)/,
    "the managed-context presence probe must iterate the canonical list",
  );
  assert.match(
    sources["extension/bash-gate-facts.ts"],
    /\.\.\.CONFIG_FILE_VARIANTS\.map\(/,
    "the fact-cache signature must be built from the canonical list",
  );
  // The same list decides what BOTH halves ignore: a config file whose variant the canonical list
  // does not carry is seen by neither, so the cwd keeps its cached verdict instead of becoming
  // managed off-list.
  const root = path.join(tmp, `off-list-${(repoSeq += 1)}`);
  fs.mkdirSync(root);
  const gate = register({ repoRoot: root });
  assert.deepEqual(await callAs(gate, "developer", MERGE), { block: false });
  fs.writeFileSync(path.join(root, ".devloops.toml"), "version: 1\nautonomy:\n  humanMergeOnly: true\n", "utf8");
  assert.deepEqual(
    await callAs(gate, "developer", MERGE),
    { block: false },
    "a variant outside the canonical list is seen by neither the probe nor the signature",
  );
});

/**
 * A repo root whose `.devloops` carries only `version` (so it IS dev-loops-managed) and whose
 * `autonomy.humanMergeOnly` therefore resolves from a DEFAULTS-layer file the caller writes later.
 */
function defaultsRepoRoot(tmp) {
  const root = path.join(tmp, `defaults-${(repoSeq += 1)}`);
  fs.mkdirSync(path.join(root, ".pi", "dev-loop"), { recursive: true });
  fs.writeFileSync(path.join(root, ".devloops"), "version: 1\n", "utf8");
  return root;
}
const defaultsFile = (root, ext) => path.join(root, ".pi", "dev-loop", `defaults${ext}`);
/** The loader parses a `.json` variant as JSON and every other variant as YAML. */
const defaultsContent = (ext, humanMergeOnly) =>
  ext === ".json" ? `${JSON.stringify({ version: 1, autonomy: { humanMergeOnly } }, null, 2)}\n` : `version: 1\nautonomy:\n  humanMergeOnly: ${humanMergeOnly}\n`;

tempTest("Pi tool_call revalidates the cached facts when any .pi/dev-loop/defaults variant appears", async (tmp) => {
  clearCoordinatorFlag();
  // The defaults layer is the OTHER half of the cache signature, and the half a managed repo can use
  // to carry `autonomy.humanMergeOnly`: a variant the loader probes but the signature skipped would
  // serve the cached pre-edit invariant for the rest of the session (fail OPEN on the merge rule).
  for (const ext of CONFIG_FILE_VARIANTS) {
    const root = defaultsRepoRoot(tmp);
    const gate = register({ repoRoot: root });
    // No defaults file yet: the packaged extension default (humanMergeOnly: true) binds.
    assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/, `defaults${ext || " (bare)"}: packaged default before`);
    fs.writeFileSync(defaultsFile(root, ext), defaultsContent(ext, false), "utf8");
    assert.match(
      (await callAs(gate, "developer", MERGE)).reason,
      /RAW-GH-PR-MERGE-BYPASS/,
      `defaults${ext || " (bare)"}: a defaults variant appearing mid-session must invalidate the cached facts`,
    );
  }
});

tempTest("Pi tool_call re-resolves when the .pi/dev-loop/defaults file that supplies the invariant is edited", async (tmp) => {
  clearCoordinatorFlag();
  const root = defaultsRepoRoot(tmp);
  const file = defaultsFile(root, ".yaml");
  fs.writeFileSync(file, defaultsContent(".yaml", false), "utf8");
  const gate = register({ repoRoot: root });
  // The invariant comes from the defaults layer, under a `.devloops` that states none: cached false.
  assert.match((await callAs(gate, "developer", MERGE)).reason, /RAW-GH-PR-MERGE-BYPASS/);
  fs.writeFileSync(file, defaultsContent(".yaml", true), "utf8");
  assert.match((await callAs(gate, "developer", MERGE)).reason, /STOP-HUMAN-MERGE-001/);
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
