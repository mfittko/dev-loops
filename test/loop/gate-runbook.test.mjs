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

test("AC2: no agent definition links the contract as the round procedure", () => {
  for (const file of readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".agent.md"))) {
    const text = readFileSync(path.join(ROOT, "agents", file), "utf8");
    for (const line of text.split("\n")) {
      if (/\]\([^)]*gate-review-sub-loop-contract\.md/.test(line) && /GATE-EXEC-GATE-COORDINATOR|round procedure/.test(line)) assert.fail(`${file}: relative contract link as round procedure: ${line.slice(0, 120)}`);
    }
  }
  const coordinator = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  assert.doesNotMatch(coordinator, /\]\([^)]*gate-review-sub-loop-contract\.md/);
});

test("AC3: every rule ID in the runbook resolves to a rule marker, and the round obligations stay named", () => {
  const marked = new Set();
  for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
    for (const m of readFileSync(path.join(DOCS, f), "utf8").matchAll(/<!--\s*rule:\s*([A-Z0-9-]+)\s*-->/g)) marked.add(m[1]);
  }
  for (const id of runbookRuleIds(runbook)) assert.ok(marked.has(id), `${id} has no rule marker`);
  for (const id of ["GATE-EXEC-GATE-COORDINATOR", "GATE-EXEC-HARNESS-JOIN", "GATE-EXEC-BOUNDED-WAIT-CAP", "GATE-EXEC-JUDGE-PHASE", "GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED", "GATE-EXEC-DISPOSITION-LEDGER", "GATE-EXEC-RECURRENCE-ESCALATION", "RECOVERY-COMMAND-REQUIRED"]) assert.ok(runbook.includes(id), `${id} dropped from the runbook`);
  for (const word of ["units_stalled", "round_retired", "ci_not_green", "head_changed", "FANOUT_UNAVAILABLE", "judgeSkipped", "escalationsSkipped"]) assert.ok(runbook.includes(word), `${word} dropped from the runbook`);
});

test("AC4: every runbook command flag appears in its CLI usage, and the runbook stays within 16,000 characters", () => {
  assert.ok(runbook.length <= 16000, `runbook is ${runbook.length} characters`);
  const usage = new Map();
  for (const { script, flags } of runbookCommands()) {
    if (!usage.has(script)) {
      const result = spawnSync(process.execPath, [path.join(ROOT, script), "--help"], { encoding: "utf8" });
      usage.set(script, `${result.stdout}${result.stderr}`);
    }
    for (const flag of flags) assert.ok(usage.get(script).includes(flag), `${script} usage lacks ${flag}`);
  }
  assert.ok(usage.size >= 10);
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
  for (const text of [source, claude]) assert.match(text, /cli\/index\.mjs gate runbook/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "cli/index.mjs"), "gate", "runbook"], { encoding: "utf8" });
  assert.equal(cli.stdout, runbook);
  // The Pi step on the same runbook keeps the blocking join, and the harness-neutral dispatch rules stay named.
  assert.match(runbook, /On Pi send the wave as ONE `subagent` call/);
  assert.match(runbook, /GATE-EXEC-HARNESS-JOIN/);
});
