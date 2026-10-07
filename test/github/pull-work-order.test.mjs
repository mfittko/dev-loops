// Work-order pull transport (#2416): compact reference -> sanctioned pull ->
// verified work order + pull receipt under the MAIN checkout's tmp root.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { DISPATCH_POINTER_MAX_BYTES, WorkOrderRefusal, buildDispatchPointer, executionIndexPath, materializationHash, pullReceiptPath, pullWorkOrder, registerWorkOrderRole, verifyPullReceipt, workOrderDigest, writeExecutionIndex } from "../../scripts/github/_work-order-protocol.mjs";
import { emitJudgeWorkOrder } from "../../scripts/loop/emit-judge-work-order.mjs";
import { seedJudgeSources } from "../loop/_judge-delivery-fixture.mjs";
import { withTempDir } from "../_helpers.mjs";
import { main as pullMain, pullDelegationTarget, shouldRetryFixerPullLocally } from "../../scripts/github/pull-work-order.mjs";
import { buildGateEmitPlanPath } from "../../scripts/github/write-gate-context.mjs";
import { decideFixerWriteGuard } from "../../packages/core/src/claude/hook-decisions.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";

const SCRIPTS = path.resolve("scripts/github");
const HEAD = "c".repeat(40);
const GATE = "pre_approval_gate";

const run = (script, args, cwd) => spawnSync("node", [path.join(SCRIPTS, script), ...args], { cwd, encoding: "utf8" });
const pull = (unit, cwd, over = {}) => run("pull-work-order.mjs", [
  "--ref", over.ref ?? unit.workOrderRef, "--digest", over.digest ?? unit.workOrderDigest, "--execution", over.execution ?? unit.executionIdentity,
], cwd);
// The short pull (ADR 0115): the execution identity alone, resolved through the execution index.
const pullShort = (execution, cwd) => run("pull-work-order.mjs", [execution], cwd);
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
    for (const bad of [`${unit.workOrderRef};id`, "$(id)", "#x", "a b"]) assert.throws(() => buildDispatchPointer({ ...unit, workOrderRef: bad }), /not shell-safe/);
  });
});

test("the dispatch envelope fits the cap for a worst-case sanctioned identity and throws one byte over it", () => {
  const worst = { workOrderRef: `review:${"o".repeat(39)}/${"r".repeat(40)}#99999:pre_approval_gate:${"f".repeat(64)}:pre-approval-gate-${"g".repeat(30)}`, workOrderDigest: "f".repeat(64), executionIdentity: "r1790000000000-abcdef12-u99" };
  assert.ok(Buffer.byteLength(buildDispatchPointer(worst)) <= DISPATCH_POINTER_MAX_BYTES);
  const pad = DISPATCH_POINTER_MAX_BYTES - Buffer.byteLength(buildDispatchPointer({ ...worst, workOrderRef: "a" }));
  assert.equal(Buffer.byteLength(buildDispatchPointer({ ...worst, workOrderRef: "a".repeat(1 + pad) })), DISPATCH_POINTER_MAX_BYTES);
  assert.throws(() => buildDispatchPointer({ ...worst, workOrderRef: "a".repeat(2 + pad) }), /over DISPATCH_POINTER_MAX_BYTES/);
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

test("a typed ref or digest is a retryable dispatch_reference_mismatch; the same unit then pulls without re-emit or retirement", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const planBefore = await readFile(planPath, "utf8");
    const typoDigest = `${unit.workOrderDigest.slice(0, -1)}${unit.workOrderDigest.endsWith("0") ? "1" : "0"}`;
    const typoRefs = [`${unit.workOrderRef}x`, unit.workOrderRef.replace(GATE, "pre_aproval_gate"), unit.workOrderRef.replace("#7:", "#0:")];
    for (const over of [{ digest: typoDigest }, ...typoRefs.map((ref) => ({ ref }))]) {
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
    assert.equal(refusal(pullShort(unit.executionIdentity, root)).refusal, "semantic_identity_mismatch");

    await writeFile(planPath, JSON.stringify(plan), "utf8");
    await writeFile(unit.promptPath, `${await readFile(unit.promptPath, "utf8")} `, "utf8");
    assert.equal(refusal(pull(unit, root)).refusal, "local_materialization_integrity_failure");
    assert.equal(refusal(pullShort(unit.executionIdentity, root)).refusal, "local_materialization_integrity_failure");
    await rm(unit.promptPath);
    assert.equal(refusal(pull(unit, root)).refusal, "local_materialization_integrity_failure");
    assert.equal(refusal(pullShort(unit.executionIdentity, root)).refusal, "local_materialization_integrity_failure");
    // A self-consistent work order without the widening rule fails the review adapter.
    const [invalid] = plan.units;
    delete invalid.workOrder.executionRules.widening;
    invalid.workOrderDigest = workOrderDigest(invalid.workOrder);
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    assert.equal(refusal(pull(unit, root, { digest: invalid.workOrderDigest })).refusal, "invalid_work_order");
    const entry = JSON.parse(await readFile(indexPath(root, unit), "utf8"));
    await writeFile(indexPath(root, unit), JSON.stringify({ ...entry, workOrderDigest: invalid.workOrderDigest }), "utf8");
    assert.equal(refusal(pullShort(unit.executionIdentity, root)).refusal, "invalid_work_order");
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
    assert.equal(refusal(pullShort(retiredUnit.executionIdentity, root)).refusal, "stale_dispatch");
    assert.equal(pullShort(current.executionIdentity, root).status, 0);
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
    const pulled = await pullWorkOrder({ ref: unit.workOrderRef, digest: unit.workOrderDigest, execution: unit.executionIdentity, tmpRoots: [c, a, b].map((root) => path.join(root, "tmp")), receiptTmpRoot: b });
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

// ---------------------------------------------------------------------------
// Step 1 of ADR 0115: the pull also accepts the execution identity alone.
// ---------------------------------------------------------------------------

test("the short pull prints the same work order and writes the same receipt as the 3-flag pull, for a review and a judge unit", async () => {
  await withDir(async (root) => {
    const review = await emitRound(root);
    const judge = await emitJudgeWorkOrder(await seedJudgeSources(root, { headSha: HEAD }));
    for (const unit of [review, judge]) {
      const receiptFile = pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef);
      const shortPull = pullShort(unit.executionIdentity, root);
      assert.equal(shortPull.status, 0, shortPull.stdout + shortPull.stderr);
      assert.equal(shortPull.stdout, await readFile(unit.promptPath, "utf8"));
      const shortReceipt = JSON.parse(await readFile(receiptFile, "utf8"));
      assert.equal(pull(unit, root).status, 0);
      const flagReceipt = JSON.parse(await readFile(receiptFile, "utf8"));
      assert.deepEqual({ ...shortReceipt, pulledAt: undefined }, { ...flagReceipt, pulledAt: undefined });
      const { executionIdentity, workOrderRef, workOrderDigest: digest, materializationHash: hash } = unit;
      assert.deepEqual({ executionIdentity, workOrderRef, workOrderDigest: digest, materializationHash: hash, role: workOrderRef.split(":")[0] },
        { executionIdentity: shortReceipt.executionIdentity, workOrderRef: shortReceipt.workOrderRef, workOrderDigest: shortReceipt.workOrderDigest, materializationHash: shortReceipt.materializationHash, role: shortReceipt.role });
    }
  });
});

test("the pull takes one positional identity or all three flags; any other shape exits 2 with the usage text", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    for (const args of [[], [unit.executionIdentity, "--execution", unit.executionIdentity], ["--ref", unit.workOrderRef, "--execution", unit.executionIdentity], [unit.executionIdentity, unit.executionIdentity]]) {
      const result = run("pull-work-order.mjs", args, root);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /Usage: pull-work-order\.mjs <executionIdentity>/);
    }
  });
});

test("each emitted unit has one execution index entry; a colliding entry refuses the write", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    assert.deepEqual(JSON.parse(await readFile(indexPath(root, unit), "utf8")), { executionIdentity: unit.executionIdentity, workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest });
    const entry = { executionIdentity: "r1-abcdef12-u0", workOrderRef: "review:o/r#7:x", workOrderDigest: "sha256:0" };
    await writeExecutionIndex(path.join(root, "tmp"), entry);
    await writeExecutionIndex(path.join(root, "tmp"), entry);
    await assert.rejects(writeExecutionIndex(path.join(root, "tmp"), { ...entry, workOrderDigest: "sha256:1" }), (err) => err.refusal === "execution_index_collision");
  });
});

test("the short pull: an unknown identity or a typed index entry is a retryable dispatch_reference_mismatch; the same unit then pulls", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const indexBefore = await readFile(indexPath(root, unit), "utf8");
    for (const identity of [`${unit.executionIdentity}9`, "r1-abcdef12-u0", "../x"]) {
      const body = refusal(pullShort(identity, root));
      assert.equal(body.refusal, "dispatch_reference_mismatch");
      assert.equal(body.retryable, true);
    }
    const typoDigest = `${unit.workOrderDigest.slice(0, -1)}${unit.workOrderDigest.endsWith("0") ? "1" : "0"}`;
    for (const over of [{ workOrderDigest: typoDigest }, { workOrderRef: `${unit.workOrderRef}x` }]) {
      await writeFile(indexPath(root, unit), JSON.stringify({ ...JSON.parse(indexBefore), ...over }), "utf8");
      const body = refusal(pullShort(unit.executionIdentity, root));
      assert.equal(body.refusal, "dispatch_reference_mismatch");
      assert.equal(body.retryable, true);
    }
    await writeFile(indexPath(root, unit), indexBefore, "utf8");
    assert.equal(pullShort(unit.executionIdentity, root).status, 0);
  });
});

test("the short pull: a corrupt or mis-shaped execution index entry refuses with structured JSON and exit 1", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const valid = await readFile(indexPath(root, unit), "utf8");
    const entry = JSON.parse(valid);
    const { workOrderDigest: _digest, ...noDigest } = entry;
    const shapes = [
      JSON.stringify({ ...entry, workOrderRef: 7 }),
      JSON.stringify(noDigest),
      JSON.stringify({ ...entry, executionIdentity: "r1-0000beef-u0" }),
    ];
    for (const bytes of ["{ truncated", "null", "[]", "{}", ...shapes]) {
      await writeFile(indexPath(root, unit), bytes, "utf8");
      const result = pullShort(unit.executionIdentity, root);
      assert.doesNotMatch(result.stderr, /SyntaxError/);
      const body = refusal(result);
      assert.equal(body.refusal, "local_materialization_integrity_failure", bytes);
      assert.match(body.error, /is not a valid entry/);
    }
    await rm(indexPath(root, unit));
    await mkdir(indexPath(root, unit));
    const unreadable = refusal(pullShort(unit.executionIdentity, root));
    assert.equal(unreadable.refusal, "local_materialization_integrity_failure");
    assert.match(unreadable.error, /is unreadable \(EISDIR\)/);
    await rm(indexPath(root, unit), { recursive: true });
    await writeFile(indexPath(root, unit), valid, "utf8");
    assert.equal(pullShort(unit.executionIdentity, root).status, 0);
  });
});

test("the short pull: a plan digest edited after dispatch refuses as dispatch_reference_mismatch", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const planPath = buildGateEmitPlanPath({ repo: "o/r", pr: "7", gate: GATE, headSha: HEAD, tmpRoot: path.join(root, "tmp") });
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.units[0].workOrderDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    assert.equal(refusal(pullShort(unit.executionIdentity, root)).refusal, "dispatch_reference_mismatch");
  });
});

test("the short pull: an identity of a superseded round refuses as stale_dispatch", async () => {
  await withDir(async (root) => {
    const old = await emitRound(root);
    const current = await emitRound(root, { prompt: "Review the coverage angle, including error paths." });
    assert.equal(refusal(pullShort(old.executionIdentity, root)).refusal, "stale_dispatch");
    assert.equal(pullShort(current.executionIdentity, root).status, 0);
  });
});

test("the short pull: an identity whose prefix role differs from its index ref refuses as dispatch_identity_mismatch", async () => {
  await withDir(async (root) => {
    const unit = await emitRound(root);
    const fixerIdentity = "f1790000000000-abcdef12";
    await writeExecutionIndex(path.join(root, "tmp"), { executionIdentity: fixerIdentity, workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest });
    assert.equal(refusal(pullShort(fixerIdentity, root)).refusal, "dispatch_identity_mismatch");
    const ghostIdentity = "f1790000000001-abcdef12";
    await writeExecutionIndex(path.join(root, "tmp"), { executionIdentity: ghostIdentity, workOrderRef: "ghost:o/r#7:x", workOrderDigest: unit.workOrderDigest });
    assert.equal(refusal(pullShort(ghostIdentity, root)).refusal, "dispatch_identity_mismatch");
  });
});

test("the short pull: two tmp roots whose index entries for one identity differ refuse as local_materialization_integrity_failure", async () => {
  await withDir(async (a) => withDir(async (b) => {
    const unit = await emitRound(a);
    await writeExecutionIndex(path.join(b, "tmp"), { ...unit, workOrderDigest: `sha256:${"0".repeat(64)}` });
    const tmpRoots = [a, b].map((root) => path.join(root, "tmp"));
    await assert.rejects(pullWorkOrder({ execution: unit.executionIdentity, tmpRoots, receiptTmpRoot: a }), (err) => err.refusal === "local_materialization_integrity_failure");
    await writeFile(executionIndexPath(path.join(b, "tmp"), unit.executionIdentity), await readFile(indexPath(a, unit), "utf8"), "utf8");
    assert.equal((await pullWorkOrder({ execution: unit.executionIdentity, tmpRoots, receiptTmpRoot: a })).receipt.workOrderRef, unit.workOrderRef);
  }));
});

// ADR 0117 pull delegation: on a self-hosting PR the execution index entry sits in the PR worktree,
// so the pull re-runs that worktree's pull script. The stub there prints a marker and exits 7.
const DELEGATE_ID = "r1790000000001-abcdef12-u0";
async function seedDelegateCheckout(dir, { name = "dev-loops", stub = true } = {}) {
  await mkdir(path.join(dir, "scripts", "github"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  if (stub) await writeFile(path.join(dir, "scripts/github/pull-work-order.mjs"), `console.log("DELEGATED", process.cwd(), process.argv.slice(2).join(" "), process.env.DEV_LOOPS_PULL_DELEGATED);\nprocess.exit(7);\n`, "utf8");
  await writeExecutionIndex(path.join(dir, "tmp"), { executionIdentity: DELEGATE_ID, workOrderRef: `review:o/r#7:${GATE}:${HEAD}:coverage`, workOrderDigest: `sha256:${"0".repeat(64)}` });
}

// A checkout-less linked worktree of THIS repo, so the real toolchain's same-repo check accepts it as a delegate.
async function withRealLinkedWorktree(base, name, fn) {
  const linked = path.join(base, name);
  const git = (args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  git(["worktree", "add", "-q", "--detach", "--no-checkout", linked]);
  try {
    return await fn(linked);
  } finally {
    git(["worktree", "remove", "--force", linked]);
  }
}

test("self-hosting pull: from the main cwd, the pull runs the linked worktree's pull script that holds the index entry", async () => {
  await withDir(async (base) => {
    const main = process.cwd();
    await withRealLinkedWorktree(base, "linked", async (linked) => {
    await seedDelegateCheckout(linked);
    const delegated = pullShort(DELEGATE_ID, main);
    assert.equal(delegated.status, 7, delegated.stderr);
    assert.equal(delegated.stdout, `DELEGATED ${linked} ${DELEGATE_ID} 1\n`);
    // The 3-flag form forwards --ref, --digest and --execution verbatim.
    const flagArgs = ["--ref", "review:o/r#7:x", "--digest", `sha256:${"0".repeat(64)}`, "--execution", DELEGATE_ID];
    const flagged = run("pull-work-order.mjs", flagArgs, main);
    assert.equal(flagged.status, 7, flagged.stderr);
    assert.equal(flagged.stdout, `DELEGATED ${linked} ${flagArgs.join(" ")} 1\n`);
    // An injected receiptTmpRoot keeps the pull local, so the receipt lands where the caller pinned it.
    assert.equal(await pullMain([DELEGATE_ID], { cwd: main, receiptTmpRoot: base }), 1);
    // The marker stops a second delegation: the pull resolves locally and refuses as today.
    const marked = spawnSync("node", [path.join(SCRIPTS, "pull-work-order.mjs"), DELEGATE_ID], { cwd: main, encoding: "utf8", env: { ...process.env, DEV_LOOPS_PULL_DELEGATED: "1" } });
    assert.equal(refusal(marked).refusal, "dispatch_reference_mismatch");
    });
  });
});

test("pullDelegationTarget: no delegation for the own checkout, a non-dev-loops checkout, a missing pull script, the marker, or no index entry", async () => {
  await withDir(async (base) => withRealLinkedWorktree(base, "a", async (a) => withDir(async (b) => withDir(async (c) => {
    await seedDelegateCheckout(a);
    await seedDelegateCheckout(b, { name: "some-consumer-app" });
    await seedDelegateCheckout(c, { stub: false });
    const tmp = (root) => [path.join(root, "tmp")];
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(a), { env: {} }), a);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(a), { toolchainRoot: a, env: {} }), null);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(b), { env: {} }), null);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(c), { env: {} }), null);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(a), { env: { DEV_LOOPS_PULL_DELEGATED: "1" } }), null);
    assert.equal(pullDelegationTarget("r1790000000001-abcdef12-u9", tmp(a), { env: {} }), null);
    // An unrelated dev-loops checkout (its own repo) never delegates, even with index entry and pull script.
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(c), { env: {} }), null);
    await seedDelegateCheckout(c);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp(c), { env: {} }), null);
  }))));
});

test("pullDelegationTarget: a linked-worktree pull never delegates back to the main checkout's entry", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    await mkdir(main);
    const git = (args) => execFileSync("git", args, { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    git(["init", "-q"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["worktree", "add", "-q", linked]);
    await seedDelegateCheckout(main);
    await seedDelegateCheckout(linked, { stub: false });
    assert.equal(pullDelegationTarget(DELEGATE_ID, [path.join(main, "tmp")], { toolchainRoot: linked, env: {} }), null);
    // The reverse direction still delegates: toolchain = main, entry in the linked worktree.
    await seedDelegateCheckout(linked);
    assert.equal(pullDelegationTarget(DELEGATE_ID, [path.join(linked, "tmp")], { toolchainRoot: main, env: {} }), linked);
  });
});

test("self-hosting pull: a relative --tmp-root delegates as the absolute path, so the child finds the same tmp root", async () => {
  await withDir(async (base) => withRealLinkedWorktree(base, "linked", async (linked) => {
    await seedDelegateCheckout(linked);
    // This stub succeeds only when the forwarded --tmp-root resolves, under its own cwd, to a real tmp root.
    await writeFile(path.join(linked, "scripts/github/pull-work-order.mjs"), `import { existsSync } from "node:fs";\nconst tmpRoot = process.argv[process.argv.indexOf("--tmp-root") + 1];\nconsole.log(tmpRoot);\nprocess.exit(existsSync(tmpRoot + "/work-order-executions") ? 0 : 9);\n`, "utf8");
    for (const rel of ["linked/tmp", "linked/tmp/"]) {
      const r = run("pull-work-order.mjs", [DELEGATE_ID, "--tmp-root", rel], base);
      assert.equal(r.status, 0, `${rel}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, `${path.join(linked, "tmp")}\n`);
    }
  }));
});

// ADR 0123: a main-anchored fixer entry delegates to the linked worktree whose checked-out branch is the
// digest-pinned order's mutationAuthority.branch. The stub in that worktree stands in for its renderer.
const FIXER_ID = "f1790000000001-abcdef12";
async function seedFixerMain(main, { branch = "issue-9" } = {}) {
  await mkdir(main);
  const git = (args, cwd = main) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  git(["init", "-q"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  await seedDelegateCheckout(main);
  const workOrderRef = `fixer:o/r#7:${HEAD}:${FIXER_ID}`;
  await writeExecutionIndex(path.join(main, "tmp"), { executionIdentity: FIXER_ID, workOrderRef, workOrderDigest: `sha256:${"0".repeat(64)}` });
  const dir = path.join(main, "tmp", "gate-fixer", "o-r", "pr-7");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "fixer-emit-plan.json"), JSON.stringify({ workOrderRef, workOrder: { mutationAuthority: { branch, allowedPaths: ["."] } } }), "utf8");
  return git;
}

test("pullDelegationTarget: a main-anchored fixer pull delegates to the linked dev-loops worktree on the order's authority branch", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const git = await seedFixerMain(main);
    const linked = path.join(base, "unit");
    const other = path.join(base, "other");
    git(["worktree", "add", "-q", "-b", "issue-9", linked]);
    git(["worktree", "add", "-q", "-b", "issue-10", other]);
    const tmp = [path.join(main, "tmp")];
    // No dev-loops source checkout at the matching branch: the pull stays local.
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
    await seedDelegateCheckout(linked);
    await seedDelegateCheckout(other);
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), linked);
    // A branch no worktree checks out stays local.
    await writeFile(path.join(main, "tmp/gate-fixer/o-r/pr-7/fixer-emit-plan.json"), JSON.stringify({ workOrderRef: `fixer:o/r#7:${HEAD}:${FIXER_ID}`, workOrder: { mutationAuthority: { branch: "gone" } } }), "utf8");
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
  });
});

test("shouldRetryFixerPullLocally: only a fixer pull that refused with local_materialization_integrity_failure retries", () => {
  const skew = JSON.stringify({ ok: false, refusal: "local_materialization_integrity_failure" });
  assert.equal(shouldRetryFixerPullLocally(FIXER_ID, 1, skew), true);
  assert.equal(shouldRetryFixerPullLocally(FIXER_ID, 1, JSON.stringify({ refusal: "dispatch_reference_mismatch" })), false);
  assert.equal(shouldRetryFixerPullLocally(FIXER_ID, 0, "work order text"), false);
  assert.equal(shouldRetryFixerPullLocally(FIXER_ID, 1, "not json"), false);
  assert.equal(shouldRetryFixerPullLocally(DELEGATE_ID, 1, skew), false);
});

test("pullDelegationTarget: a fixer pull stays local for a consumer worktree, the serving toolchain, the marker, and gate pulls are unchanged", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const git = await seedFixerMain(main);
    const linked = path.join(base, "unit");
    git(["worktree", "add", "-q", "-b", "issue-9", linked]);
    await seedDelegateCheckout(linked, { name: "some-consumer-app" });
    const tmp = [path.join(main, "tmp")];
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
    await seedDelegateCheckout(linked);
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: linked, env: {} }), null);
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: { DEV_LOOPS_PULL_DELEGATED: "1" } }), null);
    // A main-anchored gate (r) entry still never delegates to the main checkout or by branch.
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp, { toolchainRoot: linked, env: {} }), null);
    assert.equal(pullDelegationTarget(DELEGATE_ID, tmp, { toolchainRoot: main, env: {} }), null);
  });
});

test("pullDelegationTarget: a fixer entry under a foreign tmp root or a consumer repo checkout stays local", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const git = await seedFixerMain(main);
    const linked = path.join(base, "unit");
    git(["worktree", "add", "-q", "-b", "issue-9", linked]);
    await seedDelegateCheckout(linked);
    const tmp = [path.join(main, "tmp")];
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), linked);
    const entry = await readFile(executionIndexPath(tmp[0], FIXER_ID), "utf8");
    const plan = await readFile(path.join(main, "tmp/gate-fixer/o-r/pr-7/fixer-emit-plan.json"), "utf8");
    // A consumer repo (its own git repo) and a custom tmp root hold the same entry and branch name.
    const consumer = path.join(base, "consumer");
    await mkdir(consumer);
    execFileSync("git", ["init", "-q"], { cwd: consumer, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    for (const checkout of [consumer, path.join(base, "elsewhere")]) {
      const dir = path.join(checkout, "tmp", "gate-fixer", "o-r", "pr-7");
      await mkdir(dir, { recursive: true });
      await mkdir(path.dirname(executionIndexPath(path.join(checkout, "tmp"), FIXER_ID)), { recursive: true });
      await writeFile(executionIndexPath(path.join(checkout, "tmp"), FIXER_ID), entry, "utf8");
      await writeFile(path.join(dir, "fixer-emit-plan.json"), plan, "utf8");
      assert.equal(pullDelegationTarget(FIXER_ID, [path.join(checkout, "tmp")], { toolchainRoot: main, env: {} }), null);
    }
  });
});

test("pullDelegationTarget: a fixer plan with a different workOrderRef, a missing or malformed plan, or a detached HEAD stays local", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const git = await seedFixerMain(main);
    const linked = path.join(base, "unit");
    git(["worktree", "add", "-q", "-b", "issue-9", linked]);
    await seedDelegateCheckout(linked);
    const tmp = [path.join(main, "tmp")];
    const planPath = path.join(main, "tmp/gate-fixer/o-r/pr-7/fixer-emit-plan.json");
    const good = await readFile(planPath, "utf8");
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), linked);
    await writeFile(planPath, JSON.stringify({ ...JSON.parse(good), workOrderRef: `fixer:o/r#7:${HEAD}:other` }), "utf8");
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
    await writeFile(planPath, "{ truncated", "utf8");
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
    await rm(planPath);
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
    await writeFile(planPath, good, "utf8");
    git(["checkout", "-q", "--detach"], linked);
    assert.equal(pullDelegationTarget(FIXER_ID, tmp, { toolchainRoot: main, env: {} }), null);
  });
});

test("fixer delegation keeps the receipt under the main checkout and the Edit/Write grant working", async () => {
  await withDir(async (base) => {
    const main = path.join(base, "main");
    const git = await seedFixerMain(main);
    const linked = path.join(base, "unit");
    git(["worktree", "add", "-q", "-b", "issue-9", linked]);
    // The delegated child runs under cwd = the worktree; its receipt root resolves to the main checkout's tmp.
    assert.equal(resolveGateArtifactTmpRoot(linked), path.join(main, "tmp"));
    const output = `${main}/tmp/gate-fixer/o-r/pr-7/${FIXER_ID}/fixer-disposition.json`;
    const decision = decideFixerWriteGuard({
      agentType: "fixer", targetPath: `${linked}/src/x.mjs`,
      checkouts: [{ root: main, branch: "main" }, { root: linked, branch: "issue-9" }],
      grants: [{ branch: "issue-9", allowedPaths: ["."], outputRef: output }],
    });
    assert.equal(decision.decision, "allow");
  });
});
