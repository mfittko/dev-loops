// Issue 3069: round-boundary and fix-pass hand-back, typed hand-back fields, fresh-coordinator brief.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSyncTrusted as spawnSync } from "../_helpers.mjs";
import { claimRunnerOwnership, handoffRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";
import { ROUTINE_BOUNDARY_CAP, ROUTINE_NEXT_ACTIONS, validateCoordinatorHandback } from "../../scripts/loop/_coordinator-handback.mjs";
import { runCli as handbackCli } from "../../scripts/loop/validate-coordinator-handback.mjs";
import { renderCoordinatorWorkOrder, runCli as emitCli } from "../../scripts/loop/emit-coordinator-work-order.mjs";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const sink = () => ({ text: "", write(chunk) { this.text += String(chunk); return true; } });

const MAIN = "skills/docs/main-agent-contract.md";
const ID = "COORDINATOR-ROUND-BOUNDARY-HANDBACK";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

async function rule() {
  const content = await readRepo(MAIN);
  assert.equal(content.split(`<!-- rule: ${ID} -->`).length - 1, 1, `${ID} defined once`);
  const start = content.indexOf(`<!-- rule: ${ID} -->`);
  const ends = ["\n<!-- rule:", "\n## "].map((m) => content.indexOf(m, start + 1)).filter((i) => i !== -1);
  return content.slice(start, Math.min(...ends));
}

test("AC1 the run-ending list names the gate-round end and the fix-pass end", async () => {
  const content = await readRepo(MAIN);
  assert.match(content, /one canonical list of run-ending cases[^]*?the end of a gate round, the end of a fix pass,/);
  const text = await rule();
  assert.match(text, /end of every gate round and at the end of every fix pass/);
  assert.match(text, /continues at a routine boundary and hands back at a stop/);
  assert.match(text, /fresh gate-coordinator child/);
  assert.match(text, /fresh fixer child/);
  assert.match(text, /`ROUTINE_BOUNDARY_CAP`/);
  assert.match(text, /`routineBoundaries`/);
  for (const action of ROUTINE_NEXT_ACTIONS) assert.ok(text.includes(action), `routine action ${action}`);
  for (const field of ["`pr`", "`head`", "`nextAction`", "`workerRunning`"]) assert.ok(text.includes(field), `field ${field}`);
  assert.match(text, /`COORDINATOR-HANDBACK-ONE-REPORT`/);
  assert.match(text, /`RUNNER-HANDOFF-TEARDOWN`/);
  assert.match(text, /`COORDINATOR-CONTINUITY-SOFT-CAP` stays advisory/);
  assert.match(text, /compact relay packet, which still carries `status` and the startup-output path/);
  assert.match(text, /runs `loop startup --pr <n>` before the hand-back and names that output/);
  assert.match(text, /runs the fix pass on that act list before it takes `nextAction`/);
});

test("AC1 the rule is registered and ADR 0181 carries the amendment note", async () => {
  const registry = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  const ids = JSON.stringify(registry);
  assert.ok(ids.includes(`"${ID}"`), `${ID} registered`);
  assert.match(await readRepo("docs/decisions/0181-unit-coordinator-handback-boundaries.md"), /Amended by \[0274\][^\n]*gate round[^\n]*fix pass/);
});

test("AC3 the validator refuses a hand-back with a running worker or a missing field", () => {
  const good = { pr: 7, head: HEAD, nextAction: "await_final_human_approval", workerRunning: false };
  assert.deepEqual(validateCoordinatorHandback(good), { ok: true });
  const running = validateCoordinatorHandback({ ...good, workerRunning: true });
  assert.equal(running.ok, false);
  assert.equal(running.refusal, "worker_running");
  assert.match(running.message, new RegExp(ID));
  for (const key of Object.keys(good)) {
    const { [key]: _drop, ...rest } = good;
    const missing = validateCoordinatorHandback(rest);
    assert.equal(missing.ok, false, key);
    assert.equal(missing.refusal, "missing_fields");
    assert.deepEqual(missing.missing, [key]);
  }
  assert.equal(validateCoordinatorHandback({ ...good, workerRunning: "no" }).refusal, "missing_fields");
  assert.equal(validateCoordinatorHandback(null).refusal, "missing_fields");
  for (const bad of [{ pr: 0 }, { pr: "7" }, { head: "  " }, { head: "main" }, { head: "HEAD" }, { head: "" }, { head: HEAD.slice(0, 7) }, { head: HEAD.toUpperCase() }, { head: ` ${HEAD} ` }, { nextAction: "" }, { nextAction: "   " }]) {
    assert.equal(validateCoordinatorHandback({ ...good, ...bad }).refusal, "missing_fields", JSON.stringify(bad));
  }
  assert.deepEqual(validateCoordinatorHandback({ ...good, head: "a".repeat(64) }), { ok: true });
});

test("AC1 the Unit coordinator boundaries paragraph scopes continue to draft_pr_opened and the rule orders validator before claim release", async () => {
  const content = await readRepo(MAIN);
  assert.doesNotMatch(content, /A report point never forces a successor/);
  assert.match(content, /The `draft_pr_opened` report point never forces a successor/);
  assert.doesNotMatch(content, /draft PR creation or a verdict/);
  assert.match(await rule(), /run `validate-coordinator-handback\.mjs`, release the runner claim[^\n]*only after exit 0, then hand back/);
});

test("AC4 the hand-back releases the runner claim so a fresh coordinator can claim", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "round-handback-"));
  const target = { repo: "owner/repo", pr: 7, cwd, env: {} };
  try {
    assert.equal((await claimRunnerOwnership({ ...target, runId: "coord-round-1" })).ok, true);
    assert.equal((await claimRunnerOwnership({ ...target, runId: "coord-round-2" })).ok, false);
    const released = await handoffRunnerOwnership({ ...target, runId: "coord-round-1" });
    assert.equal(released.status, "handoff_recorded");
    assert.equal(released.activeRun, null);
    assert.equal((await claimRunnerOwnership({ ...target, runId: "coord-round-2" })).ok, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC2 the emitted fresh coordinator brief derives state and embeds no head SHA or ledger path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "round-handback-emit-"));
  try {
    // Startup output for an issue with a linked PR that itself carries a head SHA and a ledger path:
    // the emitter must drop both. A kind "pr" target would bind the live PR worktree through GitHub.
    const input = path.join(dir, "startup.json");
    await writeFile(input, JSON.stringify({
      ok: true,
      bundle: {
        bundleKind: "resolved", selectedStrategy: "copilot_pr_followup", executionMode: "bounded_handoff", routeKind: "route",
        nextAction: "Run the next gate round.", requiredReads: ["skills/docs/public-dev-loop-contract.md"],
        activeArtifact: { kind: "issue", issue: 42, pr: null, linkedPr: 7, branch: null, phase: null, headSha: HEAD, ledgerPath: "tmp/gate/7.fanin-ledger.json" },
      },
    }));
    const stdout = sink();
    const stderr = sink();
    assert.equal(await emitCli(["--input", input, "--repo", "owner/repo"], { stdout, stderr }), 0, stderr.text);
    const { workOrder } = JSON.parse(stdout.text);
    const ref = `${MAIN}#${ID}`;
    assert.deepEqual(workOrder.ruleReferences.stateDerivation, [ref]);
    assert.match(await rule(), /re-resolves state with `loop startup --pr <n>` and `loop gate-coordination`/);
    const brief = renderCoordinatorWorkOrder(workOrder);
    assert.ok(brief.includes(ref));
    assert.doesNotMatch(brief, /\b[0-9a-f]{40}\b/, "no head SHA");
    assert.doesNotMatch(brief, /[\w./-]*ledger[\w-]*\.json/i, "no ledger path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC3 validate-handback exits 0 on a valid packet and 1 on a refusal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "round-handback-cli-"));
  const good = { pr: 7, head: HEAD, nextAction: "await_final_human_approval", workerRunning: false };
  try {
    const run = async (packet) => {
      const file = path.join(dir, "packet.json");
      await writeFile(file, typeof packet === "string" ? packet : JSON.stringify(packet));
      const stdout = sink();
      const code = await handbackCli({ argv: ["--packet", file], stdout, stderr: sink() });
      return { code, out: JSON.parse(stdout.text) };
    };
    assert.deepEqual(await run(good), { code: 0, out: { ok: true } });
    const running = await run({ ...good, workerRunning: true });
    assert.equal(running.code, 1);
    assert.equal(running.out.refusal, "worker_running");
    const missing = await run({ ...good, head: "" });
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.out.missing, ["head"]);
    const file = path.join(dir, "packet.json");
    await writeFile(file, JSON.stringify({ ...good, workerRunning: true }));
    assert.equal(await handbackCli({ argv: ["--packet", file, "--silent", "--jq", ".refusal"], stdout: sink(), stderr: sink() }), 1);
    assert.equal((await run("not json")).code, 1);
    assert.equal(await handbackCli({ argv: [], stdout: sink(), stderr: sink() }), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC1 the soft-cap bullet points at the run-ending cases and the fix-pass end owns the converged post", async () => {
  const content = await readRepo(MAIN);
  assert.match(content, /Fresh dispatch stays for reviewer and judge isolation and for the run-ending cases in Unit coordinator boundaries\./);
  assert.doesNotMatch(content, /Fresh dispatch stays for reviewer and judge isolation, genuine recovery/);
  assert.match(content, /eligible under `GATE-EXEC-LOW-NIT-CONVERGENCE`, the fix pass ends only after the `--converged-json` post/);
});

test("issue 3414 ac:3 a verdict post refused for red CI is recorded with the CI route as nextAction", async () => {
  const good = { pr: 7, head: HEAD, nextAction: "fix_ci_failure", workerRunning: false, verdictRefusal: { reason: "ci_red", actListPath: "tmp/act-list.json" } };
  assert.deepEqual(validateCoordinatorHandback(good), { ok: true });
  for (const bad of [{ nextAction: "run_draft_gate" }, { verdictRefusal: { reason: "ci_red" } }, { verdictRefusal: { reason: "other", actListPath: "x" } }, { verdictRefusal: { reason: "ci_red", actListPath: "   " } }, { verdictRefusal: null }]) {
    const result = validateCoordinatorHandback({ ...good, ...bad });
    assert.equal(result.refusal, "verdict_refusal_route", JSON.stringify(bad));
    assert.match(result.recovery, /--ci-file <wait-pr-checks JSON> --act-list-file/);
  }
  assert.match(await rule(), /verdictRefusal/);
});

test("issue 3414 ac:3 judge-pass --out and the ci_red recovery name the same act-list path", async () => {
  const ACT = "tmp/gate-judge/<repo-slug>/pr-<N>/<gate>-<head>/act-list.json";
  const recovery = validateCoordinatorHandback({ pr: 7, head: HEAD, nextAction: "run_draft_gate", workerRunning: false, verdictRefusal: { reason: "ci_red" } }).recovery;
  assert.ok(recovery.includes(ACT), "VERDICT_REFUSAL_RECOVERY names the act-list path");
  for (const file of [MAIN, "skills/copilot-pr-followup/SKILL.md", "skills/docs/gate-review-sub-loop-contract.md"]) {
    assert.ok((await readRepo(file)).includes(ACT), `${file} names the act-list path`);
  }
});

test("issue 3414 the emitter refusal JSON for a bad CI source carries a recovery key", () => {
  const result = spawnSync("node", [path.resolve("scripts/loop/emit-fixer-work-order.mjs"), "--harness", "claude", "--repo", "o/r", "--pr", "7", "--head-sha", HEAD, "--phase", "full", "--ci-file", "ci.json", "--threads-file", "threads.json"], { encoding: "utf8" });
  const out = JSON.parse(result.stdout);
  assert.equal(out.refusal, "ambiguous_source");
  assert.match(out.recovery, /--ci-file <wait-pr-checks JSON> --act-list-file/);
});

test("issue 3097 ac:1 a routine nextAction at a round boundary below the cap is refused with the gate-coordination route", () => {
  const base = { pr: 7, head: HEAD, workerRunning: false };
  for (const nextAction of ROUTINE_NEXT_ACTIONS) {
    const packets = [
      { nextAction, status: "gate_round_end" },
      { nextAction, status: "fix_pass_end", routineBoundaries: 0 },
      { nextAction, status: "gate_round_end", routineBoundaries: ROUTINE_BOUNDARY_CAP - 1 },
      { nextAction },
      { nextAction, status: null },
      { nextAction, status: "" },
      { nextAction, status: "   " },
      { nextAction, status: 7 },
      { nextAction, status: "gate_round_end", routineBoundaries: "3" },
      { nextAction, status: "gate_round_end", routineBoundaries: 3.5 },
      { nextAction, status: "gate_round_end", routineBoundaries: -1 },
    ];
    for (const packet of packets) {
      const result = validateCoordinatorHandback({ ...base, ...packet });
      assert.equal(result.refusal, "routine_boundary", JSON.stringify(packet));
      assert.match(result.message, new RegExp(ID));
      assert.ok(result.recovery.includes("loop gate-coordination --pr 7 --repo <owner/name>"), "names the driver with its required --repo");
      assert.ok(result.recovery.includes(`"${nextAction}"`), "names the routine action");
    }
  }
});

test("issue 3097 ac:2 a stop action, the cap and another run-ending status are accepted; the existing refusals stay", () => {
  const base = { pr: 7, head: HEAD, workerRunning: false };
  for (const nextAction of ["report_blocked", "await_final_human_approval", "report_done", "resolve_merge_conflicts"]) {
    assert.deepEqual(validateCoordinatorHandback({ ...base, nextAction, status: "gate_round_end", routineBoundaries: 0 }), { ok: true }, nextAction);
  }
  for (const nextAction of ROUTINE_NEXT_ACTIONS) {
    assert.deepEqual(validateCoordinatorHandback({ ...base, nextAction, status: "gate_round_end", routineBoundaries: ROUTINE_BOUNDARY_CAP }), { ok: true }, nextAction);
    for (const status of ["operator_direction", "lockout", "final_approval_ready", "gate_round_ended"]) {
      assert.deepEqual(validateCoordinatorHandback({ ...base, nextAction, status }), { ok: true }, `${nextAction} ${status}`);
    }
  }
  assert.equal(validateCoordinatorHandback({ ...base, nextAction: "run_draft_gate", workerRunning: true }).refusal, "worker_running");
  assert.equal(validateCoordinatorHandback({ ...base, nextAction: "" }).refusal, "missing_fields");
  assert.equal(validateCoordinatorHandback({ ...base, nextAction: "run_draft_gate", verdictRefusal: { reason: "ci_red" } }).refusal, "verdict_refusal_route");
});
