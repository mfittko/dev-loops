// Issue 3069: round-boundary and fix-pass hand-back, typed hand-back fields, fresh-coordinator brief.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimRunnerOwnership, handoffRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";
import { validateCoordinatorHandback } from "../../scripts/loop/_coordinator-handback.mjs";
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
  assert.match(text, /never continues into the next round/);
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
  const good = { pr: 7, head: HEAD, nextAction: "run_pre_approval_gate", workerRunning: false };
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
  const good = { pr: 7, head: HEAD, nextAction: "run_pre_approval_gate", workerRunning: false };
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
