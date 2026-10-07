// dev-loops gate wait-for-units: the read-only join for a gate round's dispatched units.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { pullReceiptPath } from "../scripts/github/_work-order-protocol.mjs";
import { SUBCOMMAND_ROUTES } from "../cli/index.mjs";
import { parseWaitArgs, waitForUnits } from "../scripts/loop/wait-for-gate-units.mjs";
import { withTempDir } from "./_helpers.mjs";

const HEAD = "a".repeat(40);
const GATE = "pre_approval_gate";
const withDir = (fn) => withTempDir(async (dir) => fn(await realpath(dir)), { prefix: "dev-loops-wait-units-" });
const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const setMtime = (file, seconds) => utimes(file, seconds, seconds);

function fakeClock() {
  let t = 0;
  return { now: () => t, delay: async (ms) => { t += ms; } };
}

function unitFixture(root, scope, angles, index) {
  const identity = { workOrderRef: `review:o/r#7:${GATE}:${HEAD}:${scope}`, workOrderDigest: `sha256:${scope}`, executionIdentity: `r1-u${index}` };
  const outputRefs = angles.map((angle) => path.join(root, "tmp", "findings", `${angle}.json`));
  return { unit: { scope, angles, ...identity, workOrder: { outputRefs } }, identity, outputRefs };
}

async function seedReceipt(root, identity, role = "review", seconds = 100) {
  const file = pullReceiptPath(path.join(root, "tmp"), identity.workOrderRef);
  await writeJson(file, { ...identity, role });
  await setMtime(file, seconds);
}

async function seedResult(file, seconds = 200) {
  await writeJson(file, { verdict: "clean" });
  await setMtime(file, seconds);
}

async function seedPlan(root, specs) {
  const fixtures = specs.map(([scope, angles], index) => unitFixture(root, scope, angles, index));
  const planPath = path.join(root, "tmp", "plans", `${GATE}-${HEAD}.emit-plan.json`);
  await writeJson(planPath, { ok: true, gate: GATE, headSha: HEAD, units: fixtures.map((f) => f.unit) });
  return { planPath, fixtures };
}

const run = (root, planPath, extra = {}) => waitForUnits({ emitPlan: planPath, tmpRoot: path.join(root, "tmp"), receiptTmpRoot: path.join(root, "tmp"), timeoutMs: 10000, ...fakeClock(), ...extra });

async function snapshot(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const s = await stat(full);
    out.push(`${full}:${s.size}:${s.mtimeMs}`);
  }
  return out.sort();
}

test("routes the gate subcommand to the script", () => {
  assert.equal(SUBCOMMAND_ROUTES.gate["wait-for-units"], "scripts/loop/wait-for-gate-units.mjs");
});

test("invalid input is rejected", async () => {
  assert.throws(() => parseWaitArgs(["--emit-plan", "a", "--judge-plan", "b", "--tmp-root", "t"]), /exactly one/);
  assert.throws(() => parseWaitArgs(["--tmp-root", "t"]), /exactly one/);
  assert.throws(() => parseWaitArgs(["--emit-plan", "a", "--tmp-root", "t", "--timeout-ms", "570001"]), /--timeout-ms/);
  assert.throws(() => parseWaitArgs(["--emit-plan", "a", "--tmp-root", "t", "--timeout-ms", "0"]), /--timeout-ms/);
  assert.equal(parseWaitArgs(["--emit-plan", "a", "--tmp-root", "t"]).timeoutMs, 540000);
  await withDir(async (root) => {
    const { planPath } = await seedPlan(root, [["g1", ["a"]]]);
    await assert.rejects(run(root, planPath, { units: ["nope"] }), /unknown --unit/);
    const bad = path.join(root, "bad.json");
    await writeFile(bad, "{not json");
    await assert.rejects(run(root, bad), /malformed/);
    const cli = spawnSync("node", [path.resolve("scripts/loop/wait-for-gate-units.mjs"), "--emit-plan", bad, "--tmp-root", path.join(root, "tmp")], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).ok, false);
  });
});

test("grouped unit: partial until every covered angle has a post-pull result", async () => {
  await withDir(async (root) => {
    const { planPath, fixtures } = await seedPlan(root, [["group-1", ["a", "b", "c"]]]);
    const [{ identity, outputRefs }] = fixtures;
    await seedReceipt(root, identity);
    await seedResult(outputRefs[0]);
    await seedResult(outputRefs[1]);
    const partial = await run(root, planPath);
    assert.equal(partial.outcome, "timeout");
    assert.equal(partial.unitCount, 1);
    assert.deepEqual(partial.missing, [{ scope: "group-1", executionIdentity: "r1-u0", state: "partial", missingAngles: ["c"] }]);
    await seedResult(outputRefs[2]);
    const done = await run(root, planPath);
    assert.equal(done.outcome, "all_done");
    assert.deepEqual(done.done, ["group-1"]);
  });
});

test("per-angle units: unitCount is the unit count and --unit narrows the wait", async () => {
  await withDir(async (root) => {
    const { planPath, fixtures } = await seedPlan(root, [["a", ["a"]], ["b", ["b"]], ["c", ["c"]]]);
    for (const f of fixtures.slice(0, 2)) { await seedReceipt(root, f.identity); await seedResult(f.outputRefs[0]); }
    const all = await run(root, planPath);
    assert.equal(all.unitCount, 3);
    assert.deepEqual(all.missing.map((m) => [m.scope, m.state]), [["c", "not_started"]]);
    const wave = await run(root, planPath, { units: ["a", "b"] });
    assert.equal(wave.outcome, "all_done");
    assert.equal(wave.unitCount, 2);
  });
});

test("a result older than its pull receipt never counts", async () => {
  await withDir(async (root) => {
    const { planPath, fixtures } = await seedPlan(root, [["g", ["a"]]]);
    const [{ identity, outputRefs }] = fixtures;
    await seedResult(outputRefs[0], 50);
    await seedReceipt(root, identity, "review", 100);
    const result = await run(root, planPath);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.missing[0].state, "running");
  });
});

test("a unit completing mid-wait gives all_done and a sentinel marks running", async () => {
  await withDir(async (root) => {
    const { planPath, fixtures } = await seedPlan(root, [["g", ["a"]]]);
    const [{ identity, outputRefs }] = fixtures;
    await writeJson(path.join(root, "tmp", `checkpoint-context-sentinel-g-${HEAD}.json`), {});
    const clock = fakeClock();
    let calls = 0;
    const delay = async (ms) => {
      await clock.delay(ms);
      if (++calls === 2) { await seedReceipt(root, identity); await seedResult(outputRefs[0]); }
    };
    const result = await run(root, planPath, { now: clock.now, delay });
    assert.equal(result.outcome, "all_done");
    assert.equal(result.elapsedMs, 4000);
    const early = await run(root, planPath, { timeoutMs: 1 });
    assert.equal(early.outcome, "all_done");
  });
});

test("timeout reports the pending unit with a sentinel as running", async () => {
  await withDir(async (root) => {
    const { planPath } = await seedPlan(root, [["g", ["a"]]]);
    await writeJson(path.join(root, "tmp", `checkpoint-context-sentinel-g-${HEAD}.json`), {});
    const result = await run(root, planPath, { timeoutMs: 5000 });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.elapsedMs, 5000);
    assert.equal(result.missing[0].state, "running");
  });
});

test("round_retired: removed plan and a newer retirement record for the gate", async () => {
  await withDir(async (root) => {
    const { planPath } = await seedPlan(root, [["g", ["a"]]]);
    await setMtime(planPath, 100);
    const record = path.join(root, "tmp", "retired-gate-rounds", HEAD, "round-1", "retirement.json");
    await writeJson(record, { gate: "draft_gate", retiredAt: new Date(200000).toISOString() });
    assert.equal((await run(root, planPath, { timeoutMs: 1 })).outcome, "timeout");
    await writeJson(record, { gate: GATE, retiredAt: new Date(200000).toISOString() });
    assert.equal((await run(root, planPath)).outcome, "round_retired");
    await rm(path.join(root, "tmp", "retired-gate-rounds"), { recursive: true });
    const removing = run(root, planPath, { delay: async () => { await rm(planPath); } });
    assert.equal((await removing).outcome, "round_retired");
  });
});

test("judge plan waits on the single judge unit with role judge", async () => {
  await withDir(async (root) => {
    const verdict = path.join(root, "tmp", "judge", "judge-verdict.json");
    const identity = { workOrderRef: `judge:o/r#7:${GATE}:${HEAD}:r1`, workOrderDigest: "sha256:j", executionIdentity: "r1" };
    const planPath = path.join(root, "tmp", "judge", "judge-emit-plan.json");
    await writeJson(planPath, { ...identity, workOrder: { roundIdentity: { gate: GATE, headSha: HEAD }, outputRefs: [verdict, "x"] } });
    const opts = { judgePlan: planPath, tmpRoot: path.join(root, "tmp"), receiptTmpRoot: path.join(root, "tmp"), timeoutMs: 4000, ...fakeClock() };
    assert.equal((await waitForUnits(opts)).outcome, "timeout");
    await seedReceipt(root, identity, "judge");
    await seedResult(verdict);
    const done = await waitForUnits({ ...opts, ...fakeClock() });
    assert.equal(done.outcome, "all_done");
    assert.equal(done.unitCount, 1);
  });
});

test("the command is read-only", async () => {
  await withDir(async (root) => {
    const { planPath, fixtures } = await seedPlan(root, [["g", ["a", "b"]]]);
    await seedReceipt(root, fixtures[0].identity);
    await seedResult(fixtures[0].outputRefs[0]);
    const before = await snapshot(root);
    assert.equal((await run(root, planPath, { timeoutMs: 5000 })).outcome, "timeout");
    await seedResult(fixtures[0].outputRefs[1]);
    const mid = await snapshot(root);
    assert.equal((await run(root, planPath)).outcome, "all_done");
    assert.deepEqual(await snapshot(root), mid);
    assert.notDeepEqual(before, mid);
    const source = await readFile(path.resolve("scripts/loop/wait-for-gate-units.mjs"), "utf8");
    assert.doesNotMatch(source, /child_process/);
    assert.doesNotMatch(source, /\b(writeFile|mkdir|rename|rm|unlink|appendFile|copyFile)\b\s*\(/);
  });
});
