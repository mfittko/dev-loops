import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import { CONTRACT_FILE, buildGateRunbook, runbookRuleIds } from "../../scripts/loop/gate-runbook.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = path.join(ROOT, "skills/docs");
const contract = readFileSync(path.join(DOCS, CONTRACT_FILE), "utf8");
const built = buildGateRunbook();
const runbook = built.runbook;
const RULE_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g;

function run(args, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/loop/gate-runbook.mjs"), ...args], { encoding: "utf8", ...options });
}

// Each runbook command: the script it runs and the flags it passes.
function runbookCommands() {
  const commands = [];
  for (const line of runbook.split("\n")) {
    const match = line.match(/`dev-loops-run --repo-root \$W (\S+)(?: (gate \S+))?([^`]*)`/);
    if (!match) continue;
    const [, first, gate, rest] = match;
    const script = first === "cli/index.mjs" ? SUBCOMMAND_ROUTES.gate[gate.split(" ")[1]] : first;
    commands.push({ script, name: gate ? gate.split(" ")[1] : path.basename(first), flags: [...rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]) });
  }
  return commands;
}

test("AC1: the runbook is registered, pins the command sequence, dispatches in waves and joins with --timeout", () => {
  assert.equal(built.ok, true);
  assert.equal(SUBCOMMAND_ROUTES.gate.runbook, "scripts/loop/gate-runbook.mjs");
  const scripts = runbookCommands().map((c) => path.basename(c.script));
  const expected = ["resolve-validation.mjs", "write-gate-context.mjs", "resolve-angle-carry-forward.mjs", "spec-context.mjs", "wait-pr-checks.mjs", "emit-fanout-dispatch.mjs", "resolve-reviewer-role.mjs", "wait-for-gate-units.mjs", "consolidate-fanin.mjs", "emit-judge-work-order.mjs", "wait-for-gate-units.mjs", "judge-pass.mjs", "write-gate-findings-log.mjs"];
  assert.ok(expected.every((name) => scripts.includes(name)), `missing script in ${scripts}`);
  // Order: validation, context, carry-forward, spec, ci, emit, join, fan-in, judge emit, judge pass, ledger.
  const order = ["resolve-validation.mjs", "write-gate-context.mjs", "resolve-angle-carry-forward.mjs", "spec-context.mjs", "wait-pr-checks.mjs", "emit-fanout-dispatch.mjs", "wait-for-gate-units.mjs", "consolidate-fanin.mjs", "emit-judge-work-order.mjs", "judge-pass.mjs", "write-gate-findings-log.mjs"].map((n) => scripts.indexOf(n));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const { name, script } of runbookCommands()) assert.ok(contract.includes(name) || contract.includes(path.basename(script)), `${name} is absent from the contract`);
  assert.match(runbook, /Waves \(GATE-EXEC-FANOUT-CAPACITY[^)]*\)\. Split the emitted units into waves of at most `maxConcurrent`/);
  assert.match(runbook, /gate wait-for-units --emit-plan \S+ --unit <scope> --timeout 540`/);
  assert.match(runbook, /gate wait-for-units --judge-plan <planPath> --timeout 540`/);
  assert.ok(contract.includes("wait-for-units --emit-plan <path> [--unit <scope>]"), "contract no longer shows the --emit-plan/--unit join");
  assert.match(contract, /maxConcurrent/);
  const agent = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  assert.match(agent, /gate runbook/);
  assert.match(agent, /only required read/);
});

test("AC2: the gate coordinator never references the contract, and no agent links it as the round procedure", () => {
  const coordinator = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  assert.doesNotMatch(coordinator, /gate-review-sub-loop-contract/);
  for (const file of readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".agent.md"))) {
    for (const line of readFileSync(path.join(ROOT, "agents", file), "utf8").split("\n")) {
      if (!/\]\([^)]*gate-review-sub-loop-contract/.test(line)) continue;
      // A contract link may cite a rule or section; it may not name the coordinator's rule or the round procedure.
      assert.doesNotMatch(line, /GATE-EXEC-GATE-COORDINATOR|gate[- ]coordinator.{0,80}(?:procedure|steps|round)|(?:procedure|steps|round).{0,80}gate[- ]coordinator|round procedure/i, `${file}: contract link as the round procedure: ${line.slice(0, 120)}`);
    }
  }
});

// Obligations the contract assigns to the coordinator that the runbook deliberately omits (none today).
const OUT_OF_SCOPE = new Map();

test("AC3: every rule ID in the runbook resolves to a rule marker, and every coordinator-owned GATE-EXEC rule is named", () => {
  const marked = new Set();
  for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
    for (const m of readFileSync(path.join(DOCS, f), "utf8").matchAll(/<!--\s*rule:\s*([A-Z0-9-]+)\s*-->/g)) marked.add(m[1]);
  }
  for (const id of runbookRuleIds(runbook)) assert.ok(marked.has(id), `${id} has no rule marker`);
  // Owned by the coordinator: named in its own rule body, in its agent definition, or listed here.
  const body = contract.split("<!-- rule: GATE-EXEC-GATE-COORDINATOR -->")[1].split(/<!-- rule: /)[0];
  const agent = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  const listed = ["GATE-EXEC-OPERATOR-FOCUS", "GATE-EXEC-REVIEWER-BUDGET-PREFLIGHT", "GATE-EXEC-BUILD-ONCE-SEED", "GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK", "GATE-EXEC-COLLECTABLE-DISPATCH", "GATE-EXEC-EXECUTION-RECORD", "GATE-EXEC-FANOUT-CAPACITY", "GATE-EXEC-FIRST-WAVE-RELEASE", "GATE-EXEC-FANOUT-DISPATCH-EMIT", "GATE-EXEC-VALIDATION-RESOLUTION", "GATE-EXEC-ANGLE-CARRY-FORWARD", "GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED", "GATE-EXEC-ARTIFACT-HEAD-STAMP", "GATE-EXEC-DISPOSITION-LEDGER", "GATE-EXEC-PROPORTIONALITY", "GATE-EXEC-LIGHT-ESCALATION", "GATE-EXEC-ROUND-RETIREMENT", "GATE-EXEC-NO-DEAD-END", "RECOVERY-COMMAND-REQUIRED"];
  const owned = new Set([...`${body}\n${agent}`.match(RULE_ID), ...listed].filter((id) => id.startsWith("GATE-EXEC-") || id === "RECOVERY-COMMAND-REQUIRED"));
  for (const id of owned) {
    if (OUT_OF_SCOPE.has(id)) continue;
    assert.ok(marked.has(id), `${id} has no rule marker`);
    assert.ok(runbook.includes(id), `${id} is a coordinator obligation but dropped from the runbook`);
  }
  for (const word of ["units_stalled", "round_retired", "ci_not_green", "head_changed", "FANOUT_UNAVAILABLE", "judgeSkipped", "escalationsSkipped", "budget_shortfall", "inline_single_agent", "--available-reviewers", "--operator-focus-file"]) assert.ok(runbook.includes(word), `${word} dropped from the runbook`);
});

test("AC4: every runbook command flag appears in its CLI usage, and the runbook stays within 16,000 characters", () => {
  assert.ok(runbook.length <= 16000, `runbook is ${runbook.length} characters`);
  const usage = new Map();
  const commands = runbookCommands();
  for (const { script, flags } of commands) {
    if (!usage.has(script)) {
      const result = spawnSync(process.execPath, [path.join(ROOT, script), "--help"], { encoding: "utf8" });
      usage.set(script, `${result.stdout}${result.stderr}`);
    }
    // A flag counts only as a whole token, not as the prefix of a longer flag.
    for (const flag of flags) assert.match(usage.get(script), new RegExp(`${flag}(?![\\w-])`), `${script} usage lacks ${flag}`);
  }
  assert.equal(usage.size, new Set(commands.map((c) => c.script)).size);
  assert.ok(usage.size >= 13, `only ${usage.size} distinct scripts`);
});

test("AC5: a missing contract or an unresolved rule marker fails closed with a named recovery", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-runbook-"));
  try {
    const missing = run(["--docs-dir", dir]);
    assert.notEqual(missing.status, 0);
    const missingBody = JSON.parse(missing.stderr);
    assert.equal(missingBody.reason, "contract_missing");
    assert.match(missingBody.recovery, new RegExp(`${CONTRACT_FILE}.*gate runbook`));

    cpSync(DOCS, dir, { recursive: true });
    const stripped = readFileSync(path.join(dir, CONTRACT_FILE), "utf8").replace("<!-- rule: GATE-EXEC-HARNESS-JOIN -->", "");
    writeFileSync(path.join(dir, CONTRACT_FILE), stripped);
    const unresolved = run(["--docs-dir", dir]);
    assert.notEqual(unresolved.status, 0);
    const body = JSON.parse(unresolved.stderr);
    assert.equal(body.reason, "rule_unresolved");
    assert.match(body.recovery, /GATE-EXEC-HARNESS-JOIN.*gate runbook/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC6: Pi, Claude Code and Codex read the same runbook through the agent definition and its generated asset", () => {
  const source = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  const claude = readFileSync(path.join(ROOT, ".claude/agents/gate-coordinator.md"), "utf8");
  // Pi and Codex read agents/gate-coordinator.agent.md directly; no generated Pi or Codex asset is tracked. Claude Code reads the generated copy.
  for (const text of [source, claude]) assert.match(text, /cli\/index\.mjs gate runbook/);
  assert.match(source, /^tools: .*\bsubagent\b/m, "Pi dispatches through the subagent tool");
  const tracked = spawnSync("git", ["-C", ROOT, "ls-files", ".codex", ".pi/agents", "codex"], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(tracked, /gate-coordinator/, "a generated Pi or Codex gate-coordinator asset is now tracked: assert it here");
  assert.doesNotMatch(runbook, /--harness claude/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "cli/index.mjs"), "gate", "runbook"], { encoding: "utf8" });
  assert.equal(cli.stdout, runbook);
  // The Pi step on the same runbook keeps the blocking join, and the harness-neutral dispatch rules stay named.
  assert.match(runbook, /On Pi send the wave as ONE `subagent` call/);
  assert.match(runbook, /GATE-EXEC-HARNESS-JOIN/);
});
