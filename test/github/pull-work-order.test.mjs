// Work-order pull transport (#2416): compact reference -> sanctioned pull ->
// verified work order + pull receipt under the MAIN checkout's tmp root.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { WorkOrderRefusal, materializationHash, pullReceiptPath, pullWorkOrder, registerWorkOrderRole, verifyPullReceipt, workOrderDigest } from "../../scripts/github/_work-order-protocol.mjs";
import { withTempDir } from "../_helpers.mjs";
import "../../scripts/github/pull-work-order.mjs";
import { buildGateEmitPlanPath } from "../../scripts/github/write-gate-context.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";

const SCRIPTS = path.resolve("scripts/github");
const HEAD = "c".repeat(40);
const GATE = "pre_approval_gate";

const run = (script, args, cwd) => spawnSync("node", [path.join(SCRIPTS, script), ...args], { cwd, encoding: "utf8" });
const pull = (unit, cwd, over = {}) => run("pull-work-order.mjs", [
  "--ref", over.ref ?? unit.workOrderRef, "--digest", over.digest ?? unit.workOrderDigest, "--execution", over.execution ?? unit.executionIdentity,
], cwd);
const refusal = (result) => (assert.equal(result.status, 1, result.stderr), JSON.parse(result.stdout));
const withDir = (fn) => withTempDir(async (dir) => fn(await realpath(dir)), { prefix: "dev-loops-pull-" });

// Seed one gate-context bundle and emit its round. The briefing prefix embeds
// the checkout's absolute path, as the real write-gate-context.mjs prefix does.
async function emitRound(root, { prompt = "Review the coverage angle." } = {}) {
  const dir = path.join(root, "tmp", "gate-context", "o-r", "pr-7");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: coverage\n        persona: review\n        prompt: ${prompt}\n`, "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.briefing-prefix.txt`), `## Invariant prefix\nfindings: ${root}/tmp/gate-reviews\n`, "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.briefing-volatile.txt`), "# volatile tail\n", "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.json`), JSON.stringify({ fanout: { groups: [{ name: "coverage", angles: ["coverage"] }] } }), "utf8");
  const emitted = run("emit-fanout-dispatch.mjs", ["--repo", "o/r", "--pr", "7", "--gate", GATE, "--head-sha", HEAD], root);
  assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
  return JSON.parse(emitted.stdout).units[0];
}

test("pull returns exactly the emitted work order, carrying the widening rule, and writes the receipt", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const result = pull(unit, root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, await readFile(unit.promptPath, "utf8"));
    assert.match(result.stdout, /Widening: .*MAY read further code, spec, contracts or prior findings.*`contextWidened`/);
    assert.match(unit.workOrder.executionRules.widening, /contextWidened/);
    const receipt = JSON.parse(await readFile(pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef), "utf8"));
    assert.deepEqual(
      { ...receipt, pulledAt: undefined },
      { executionIdentity: unit.executionIdentity, role: "review", workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest,
        materializationHash: unit.materializationHash, subject: { repo: "o/r", pr: 7, gate: GATE, headSha: HEAD, roundId: unit.executionIdentity.replace(/-u\d+$/, ""), scope: unit.scope }, pulledAt: undefined },
    );
  });
});

test("workOrderDigest is equal across two checkout roots with different materializationHash; a semantic input change changes it", async () => {
  await withDir(async (a) => withDir(async (b) => withDir(async (c) => {
    const [ua, ub] = [await emitRound(a), await emitRound(b)];
    assert.equal(ua.workOrderDigest, ub.workOrderDigest);
    assert.notEqual(ua.materializationHash, ub.materializationHash);
    const uc = await emitRound(c, { prompt: "Review the coverage angle, including error paths." });
    assert.notEqual(uc.workOrderDigest, ua.workOrderDigest);
  })));
});

test("a typed ref or digest is a retryable dispatch_reference_mismatch; the same unit then pulls without re-emit or retirement", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const planBefore = await readFile(planPath, "utf8");
    for (const over of [{ digest: `${unit.workOrderDigest.slice(0, -1)}0` }, { ref: `${unit.workOrderRef}x` }]) {
      const body = refusal(pull(unit, root, over));
      assert.equal(body.refusal, "dispatch_reference_mismatch");
      assert.equal(body.retryable, true);
    }
    assert.equal(existsSync(pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef)), false);
    assert.equal(pull(unit, root).status, 0);
    assert.equal(await readFile(planPath, "utf8"), planBefore);
    assert.equal(existsSync(path.join(root, "tmp", "retired-gate-rounds")), false);
    assert.equal(refusal(pull(unit, root, { execution: `${unit.executionIdentity}9` })).refusal, "dispatch_identity_mismatch");
  });
});

test("semantic mutation refuses as semantic_identity_mismatch; a materialization-only change as local_materialization_integrity_failure", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const mutated = structuredClone(plan);
    mutated.units[0].workOrder.angleInstructions[0].prompt = "Something else.";
    await writeFile(planPath, JSON.stringify(mutated), "utf8");
    assert.equal(refusal(pull(unit, root)).refusal, "semantic_identity_mismatch");

    await writeFile(planPath, JSON.stringify(plan), "utf8");
    await writeFile(unit.promptPath, `${await readFile(unit.promptPath, "utf8")} `, "utf8");
    assert.equal(refusal(pull(unit, root)).refusal, "local_materialization_integrity_failure");
    await rm(unit.promptPath);
    assert.equal(refusal(pull(unit, root)).refusal, "local_materialization_integrity_failure");
  });
});

test("a ref bound to a retired same-head round refuses as stale even when a newer round emits the same unit", async () => {
  await withDir(async (root) => {
    const retiredUnit = await emitRound(root);
    // A live round has reviewer sentinels; retirement moves them and records the round.
    await writeFile(path.join(root, "tmp", `checkpoint-context-sentinel-pre-approval-gate-coverage-${HEAD}.json`), "{}", "utf8");
    const retired = run("retire-gate-round.mjs", ["--gate", GATE, "--head-sha", HEAD, "--reason", "test", "--no-findings-artifacts"], root);
    assert.equal(retired.status, 0, retired.stderr || retired.stdout);
    const current = await emitRound(root);
    assert.equal(current.workOrderRef, retiredUnit.workOrderRef);
    const body = refusal(pull(retiredUnit, root));
    assert.equal(body.refusal, "stale_dispatch");
    assert.match(body.error, /never retarget/);
    assert.equal(pull(current, root).status, 0);
  });
});

test("a pull from a linked-worktree cwd writes the receipt under the main checkout, where fan-in resolves it", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    await mkdir(main);
    const git = (args, cwd = main) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    git(["init", "-q"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["worktree", "add", "-q", linked]);
    const unit = await emitRound(linked);
    assert.equal(pull(unit, linked).status, 0);
    assert.equal(existsSync(pullReceiptPath(path.join(main, "tmp"), unit.workOrderRef)), true);
    assert.equal(existsSync(pullReceiptPath(path.join(linked, "tmp"), unit.workOrderRef)), false);
    // consolidate-fanin.mjs resolves the receipt root from the round's tmp root this way.
    const receiptTmpRoot = resolveGateArtifactTmpRoot(linked);
    assert.equal(receiptTmpRoot, resolveGateArtifactTmpRoot(main));
    assert.equal((await verifyPullReceipt({ receiptTmpRoot, role: "review", ...unit })).ok, true);
    assert.equal((await verifyPullReceipt({ receiptTmpRoot, role: "review", ...unit, executionIdentity: "r1-ab-u9" })).reason, "execution_mismatch");
  });
});

test("the pull is role-keyed: a stub second role pulls through its adapter, an unknown role refuses", async () => {
  await withDir(async (root) => {
    const materializationPath = path.join(root, "stub.txt");
    await writeFile(materializationPath, "stub work order\n", "utf8");
    const workOrder = { role: "stub", task: "x" };
    const located = { workOrder, workOrderDigest: workOrderDigest(workOrder), executionIdentity: "e1", materializationPath, materializationHash: materializationHash("stub work order\n"), subject: { id: 1 } };
    registerWorkOrderRole("stub", { locate: async ({ ref }) => (ref === "stub:1" ? located : null), validate: () => null });
    const args = { ref: "stub:1", digest: located.workOrderDigest, execution: "e1", tmpRoots: [], receiptTmpRoot: root };
    const pulled = await pullWorkOrder(args);
    assert.equal(pulled.workOrderText, "stub work order\n");
    assert.equal(pulled.receipt.role, "stub");
    const refused = async (over) => pullWorkOrder({ ...args, ...over }).then(() => assert.fail("expected refusal"), (err) => (assert.ok(err instanceof WorkOrderRefusal), err.refusal));
    assert.equal(await refused({ ref: "nope:1" }), "unknown_role");
    located.workOrder = { role: "review", task: "x" };
    located.workOrderDigest = workOrderDigest(located.workOrder);
    assert.equal(await refused({ digest: located.workOrderDigest }), "dispatch_identity_mismatch");
    located.workOrder = { role: "ghost", task: "x" };
    located.workOrderDigest = workOrderDigest(located.workOrder);
    assert.equal(await refused({ digest: located.workOrderDigest }), "unknown_role");
  });
});
