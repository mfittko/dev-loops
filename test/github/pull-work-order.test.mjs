// Work-order pull transport (#2416): compact reference -> sanctioned pull ->
// verified work order + pull receipt under the MAIN checkout's tmp root.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { DISPATCH_POINTER_MAX_BYTES, WORK_ORDER_ROLES, WorkOrderRefusal, buildDispatchPointer, executionIndexPath, materializationHash, pullReceiptPath, pullWorkOrder, registerWorkOrderRole, verifyPullReceipt, workOrderDigest, writeExecutionIndex } from "../../scripts/github/_work-order-protocol.mjs";
import { withTempDir } from "../_helpers.mjs";
import "../../scripts/github/pull-work-order.mjs";
import { buildGateEmitPlanPath } from "../../scripts/github/write-gate-context.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";

const SCRIPTS = path.resolve("scripts/github");
const HEAD = "c".repeat(40);
const GATE = "pre_approval_gate";

const run = (script, args, cwd) => spawnSync("node", [path.join(SCRIPTS, script), ...args], { cwd, encoding: "utf8" });
const pull = (unit, cwd, execution = unit.executionIdentity) => run("pull-work-order.mjs", [execution], cwd);
const indexPath = (root, unit) => executionIndexPath(path.join(root, "tmp"), unit.executionIdentity);
const refusal = (result) => (assert.equal(result.status, 1, result.stderr), JSON.parse(result.stdout));
const withDir = (fn) => withTempDir(async (dir) => fn(await realpath(dir)), { prefix: "dev-loops-pull-" });

// Seed one gate-context bundle and emit its round. The briefing prefix and the
// hashed required reads embed the checkout's absolute path, as the real prefix,
// evidence validation pointer and validation.json do.
async function emitRound(root, { prompt = "Review the coverage angle." } = {}) {
  const evidence = `## Validation results at this head\n  ${root}/tmp/validation.json\n`;
  const dir = path.join(root, "tmp", "gate-context", "o-r", "pr-7");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: coverage\n        persona: review\n        prompt: ${prompt}\n`, "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.briefing-prefix.txt`), `## Invariant prefix\nfindings: ${root}/tmp/gate-reviews\n`, "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.briefing-volatile.txt`), "# volatile tail\n", "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD}.json`), JSON.stringify({ fanout: { groups: [{ name: "coverage", angles: ["coverage"] }] }, requiredReads: [
    { kind: "evidence", path: "tmp/evidence.md", sha256: materializationHash(evidence), bytes: evidence.length, required: true },
    { kind: "validation", path: "tmp/validation.json", sha256: materializationHash(root), bytes: root.length, required: false },
  ] }), "utf8");
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

test("the dispatchPrompt carries a shell-runnable pull command; shell metacharacters refuse", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const args = unit.dispatchPrompt.match(/`dev-loops-run scripts\/github\/pull-work-order\.mjs ([^`]+)`/)[1];
    const result = spawnSync("sh", ["-c", `node ${path.join(SCRIPTS, "pull-work-order.mjs")} ${args}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.stdout, await readFile(unit.promptPath, "utf8"), result.stderr);
    assert.equal(unit.dispatchPrompt, `Run \`dev-loops-run scripts/github/pull-work-order.mjs ${unit.executionIdentity}\`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`);
    assert.doesNotMatch(unit.dispatchPrompt, /--ref|--digest|sha256:/);
    for (const bad of [`${unit.executionIdentity};id`, "$(id)", "x1-abcdef12", "r1-ab-u1", "a b"]) assert.throws(() => buildDispatchPointer({ executionIdentity: bad }), /EXECUTION_IDENTITY_RE/);
  });
});

test("the dispatch envelope fits the cap and throws one byte over it", () => {
  assert.ok(Buffer.byteLength(buildDispatchPointer({ executionIdentity: "r1790000000000-abcdef12-u99" })) <= DISPATCH_POINTER_MAX_BYTES);
  const pad = DISPATCH_POINTER_MAX_BYTES - Buffer.byteLength(buildDispatchPointer({ executionIdentity: "f1-abcdef12" }));
  assert.equal(Buffer.byteLength(buildDispatchPointer({ executionIdentity: `f1${"0".repeat(pad)}-abcdef12` })), DISPATCH_POINTER_MAX_BYTES);
  assert.throws(() => buildDispatchPointer({ executionIdentity: `f1${"0".repeat(pad + 1)}-abcdef12` }), /over DISPATCH_POINTER_MAX_BYTES/);
});

test("the pull takes one positional identity; the 3-flag form exits 2 with the usage text", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const result = run("pull-work-order.mjs", ["--ref", unit.workOrderRef, "--digest", unit.workOrderDigest, "--execution", unit.executionIdentity], root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: pull-work-order\.mjs <executionIdentity>/);
    assert.equal(run("pull-work-order.mjs", [], root).status, 2);
  });
});

test("each emitted unit has one execution index entry; a colliding entry refuses the emission", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    assert.deepEqual(JSON.parse(await readFile(indexPath(root, unit), "utf8")), { executionIdentity: unit.executionIdentity, workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest });
    const entry = { executionIdentity: "r1-abcdef12-u0", workOrderRef: "review:o/r#7:x", workOrderDigest: "sha256:0" };
    await writeExecutionIndex(path.join(root, "tmp"), entry);
    await writeExecutionIndex(path.join(root, "tmp"), entry);
    await assert.rejects(writeExecutionIndex(path.join(root, "tmp"), { ...entry, workOrderDigest: "sha256:1" }), (err) => err.refusal === "execution_index_collision");
  });
});

test("workOrderDigest is equal across two checkout roots whose required reads hash differently; a semantic input change changes it", async () => {
  await withDir(async (a) => withDir(async (b) => withDir(async (c) => {
    const [ua, ub] = [await emitRound(a), await emitRound(b)];
    assert.notEqual(ua.workOrder.requiredReads[0].sha256, ub.workOrder.requiredReads[0].sha256);
    assert.equal(ua.workOrderDigest, ub.workOrderDigest);
    assert.notEqual(ua.materializationHash, ub.materializationHash);
    const uc = await emitRound(c, { prompt: "Review the coverage angle, including error paths." });
    assert.notEqual(uc.workOrderDigest, ua.workOrderDigest);
  })));
});

test("an unknown identity or an index entry with a typed ref or digest is a retryable dispatch_reference_mismatch; the same unit then pulls", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const planBefore = await readFile(planPath, "utf8");
    const indexBefore = await readFile(indexPath(root, unit), "utf8");
    for (const identity of [`${unit.executionIdentity}9`, "r1-abcdef12-u0", "../x"]) {
      const body = refusal(pull(unit, root, identity));
      assert.equal(body.refusal, "dispatch_reference_mismatch");
      assert.equal(body.retryable, true);
    }
    const typoDigest = `${unit.workOrderDigest.slice(0, -1)}${unit.workOrderDigest.endsWith("0") ? "1" : "0"}`;
    const typoRefs = [`${unit.workOrderRef}x`, unit.workOrderRef.replace(GATE, "pre_aproval_gate"), unit.workOrderRef.replace("#7:", "#0:")];
    for (const over of [{ workOrderDigest: typoDigest }, ...typoRefs.map((workOrderRef) => ({ workOrderRef }))]) {
      await writeFile(indexPath(root, unit), JSON.stringify({ ...JSON.parse(indexBefore), ...over }), "utf8");
      const body = refusal(pull(unit, root));
      assert.equal(body.refusal, "dispatch_reference_mismatch");
      assert.equal(body.retryable, true);
    }
    await writeFile(indexPath(root, unit), indexBefore, "utf8");
    assert.equal(existsSync(pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef)), false);
    assert.equal(pull(unit, root).status, 0);
    assert.equal(await readFile(planPath, "utf8"), planBefore);
    assert.equal(existsSync(path.join(root, "tmp", "retired-gate-rounds")), false);
  });
});

test("a plan digest edited after dispatch refuses as dispatch_reference_mismatch", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.units[0].workOrderDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    assert.equal(refusal(pull(unit, root)).refusal, "dispatch_reference_mismatch");
  });
});

test("an identity whose prefix role differs from its index ref refuses as dispatch_identity_mismatch", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const fixerIdentity = "f1790000000000-abcdef12";
    await writeExecutionIndex(path.join(root, "tmp"), { executionIdentity: fixerIdentity, workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest });
    assert.equal(refusal(pull(unit, root, fixerIdentity)).refusal, "dispatch_identity_mismatch");
  });
});

test("two tmp roots whose index entries for one identity differ refuse as local_materialization_integrity_failure", async () => {
  await withDir(async (a) => withDir(async (b) => {
    const unit = await emitRound(a);
    await writeExecutionIndex(path.join(b, "tmp"), { ...unit, workOrderDigest: `sha256:${"0".repeat(64)}` });
    const tmpRoots = [a, b].map((root) => path.join(root, "tmp"));
    await assert.rejects(pullWorkOrder({ execution: unit.executionIdentity, tmpRoots, receiptTmpRoot: a }), (err) => err.refusal === "local_materialization_integrity_failure");
    await writeFile(executionIndexPath(path.join(b, "tmp"), unit.executionIdentity), await readFile(indexPath(a, unit), "utf8"), "utf8");
    assert.equal((await pullWorkOrder({ execution: unit.executionIdentity, tmpRoots, receiptTmpRoot: a })).receipt.workOrderRef, unit.workOrderRef);
  }));
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
    // A self-consistent work order without the widening rule fails the review adapter.
    const [invalid] = plan.units;
    delete invalid.workOrder.executionRules.widening;
    invalid.workOrderDigest = workOrderDigest(invalid.workOrder);
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    await writeFile(indexPath(root, unit), JSON.stringify({ executionIdentity: unit.executionIdentity, workOrderRef: unit.workOrderRef, workOrderDigest: invalid.workOrderDigest }), "utf8");
    assert.equal(refusal(pull(unit, root)).refusal, "invalid_work_order");
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

test("a ref from a superseded same-head round refuses as stale_dispatch, never as a retryable typo", async () => {
  await withDir(async (root) => {
    const old = await emitRound(root);
    const current = await emitRound(root, { prompt: "Review the coverage angle, including error paths." });
    assert.notEqual(current.workOrderDigest, old.workOrderDigest);
    const body = refusal(pull(old, root));
    assert.equal(body.refusal, "stale_dispatch");
    assert.equal(body.retryable, false);
    assert.match(body.error, /superseded/);
    assert.equal(pull(current, root).status, 0);
  });
});

test("the plan search prefers the checkout holding the execution's own round, then the supplied digest", async () => {
  await withDir(async (a) => withDir(async (b) => withDir(async (c) => {
    await emitRound(a, { prompt: "Other prompt." });
    await emitRound(c); // an older same-ref plan with an EQUAL digest, searched first
    const unit = await emitRound(b);
    const pulled = await pullWorkOrder({ execution: unit.executionIdentity, tmpRoots: [c, a, b].map((root) => path.join(root, "tmp")), receiptTmpRoot: b });
    assert.equal(pulled.receipt.materializationHash, unit.materializationHash);
  })));
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

test("the pull is role-keyed: a stub adapter pulls through the registry, an unknown role refuses", async () => {
  await withDir(async (root) => {
    const materializationPath = path.join(root, "stub.txt");
    await writeFile(materializationPath, "stub work order\n", "utf8");
    const execution = "j1-abcdef12";
    const workOrder = { role: "judge", task: "x" };
    const located = { workOrder, workOrderDigest: workOrderDigest(workOrder), executionIdentity: execution, materializationPath, materializationHash: materializationHash("stub work order\n"), subject: { id: 1 } };
    const judgeAdapter = WORK_ORDER_ROLES.get("judge");
    registerWorkOrderRole("judge", { locate: async ({ ref }) => (ref === "judge:1" ? located : null), validate: () => null });
    try {
      const index = (entry) => writeFile(executionIndexPath(root, execution), JSON.stringify({ executionIdentity: execution, workOrderRef: "judge:1", ...entry }), "utf8");
      await writeExecutionIndex(root, { executionIdentity: execution, workOrderRef: "judge:1", workOrderDigest: located.workOrderDigest });
      const args = { execution, tmpRoots: [root], receiptTmpRoot: root };
      const pulled = await pullWorkOrder(args);
      assert.equal(pulled.workOrderText, "stub work order\n");
      assert.equal(pulled.receipt.role, "judge");
      const refused = async () => pullWorkOrder(args).then(() => assert.fail("expected refusal"), (err) => (assert.ok(err instanceof WorkOrderRefusal), err.refusal));
      await index({ workOrderRef: "nope:1", workOrderDigest: located.workOrderDigest });
      assert.equal(await refused(), "unknown_role");
      located.workOrder = { role: "review", task: "x" };
      located.workOrderDigest = workOrderDigest(located.workOrder);
      await index({ workOrderDigest: located.workOrderDigest });
      assert.equal(await refused(), "dispatch_identity_mismatch");
      located.workOrder = { role: "ghost", task: "x" };
      located.workOrderDigest = workOrderDigest(located.workOrder);
      await index({ workOrderDigest: located.workOrderDigest });
      assert.equal(await refused(), "unknown_role");
    } finally {
      registerWorkOrderRole("judge", judgeAdapter);
    }
  });
});
