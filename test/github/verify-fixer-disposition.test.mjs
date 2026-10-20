import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "bun:test";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { decideDeltaNextStep, startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";

import { initGitFixture, makeGhMock, runIdFreeEnv } from "../_helpers.mjs";
import {
  parseVerifyFixerDispositionCliArgs,
  verifyFixerDisposition,
} from "../../scripts/github/verify-fixer-disposition.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { selectActThreadBinding } from "../../scripts/github/_fixer-act-thread-bindings.mjs";
import { materializationHash, pullReceiptPath, pullWorkOrder, verifyPulledResult, workOrderDigest, writeExecutionIndex } from "../../scripts/github/_work-order-protocol.mjs";
import { emitFixerWorkOrder, renderWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { runCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { gitEnvNoDirOverrides } from "../../scripts/loop/_repo-root-resolver.mjs";
import { resolveFixerDispositionInput } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import * as legacyOwner from "../../scripts/github/_legacy-fixer-revalidation.mjs";

const REPO = "owner/repo";
const PR = 1975;
const HEAD_SHA = "a".repeat(40);
const FIX_SHA = "b".repeat(40);

function threadsPayload(threads) {
  return `${JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
  })}\n`;
}

function threadsCallEntry(threads, extra = {}) {
  return {
    assertArgs: ["api", "graphql", "--field", `owner=owner`, "--field", `name=repo`, "--field", `pr=${PR}`],
    stdout: threadsPayload(threads),
    ...extra,
  };
}

function compareEntry(sha, status, head = HEAD_SHA) {
  return {
    assertArgs: ["api", `repos/${REPO}/compare/${sha}...${head}`],
    stdout: `${JSON.stringify({ status })}\n`,
  };
}

async function withRepoRoot(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-fixer-disposition-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function liveHeadEntry(headRefOid = HEAD_SHA, statusCheckRollup = []) {
  return { assertArgs: ["pr", "view", String(PR), "--json", "headRefOid,statusCheckRollup"], stdout: `${JSON.stringify({ headRefOid, statusCheckRollup })}\n` };
}

// Prepends the live-head read the verifier makes before any checkpoint write.
// A residual-status reply on a deferred thread is answered outside the sequential entries and recorded in `residualPosts`.
function runtime(entries, repoRoot, { live = true, failResidual = false } = {}) {
  const { runChild: inner, calls } = makeGhMock(live ? [liveHeadEntry(), ...entries] : entries);
  const residualPosts = [];
  const runChild = async (cmd, args = [], env, stdin = "") => {
    if (cmd === "gh" && args.includes("POST") && String(stdin).includes("Residual delta status:")) {
      if (failResidual) return { code: 1, stderr: "boom", stdout: "" };
      residualPosts.push({ args, body: JSON.parse(stdin).body });
      return { code: 0, stderr: "", stdout: JSON.stringify({ id: 9, html_url: "https://example.com/9" }) };
    }
    return inner(cmd, args, env, stdin);
  };
  return { deps: { env: runIdFreeEnv(), ghCommand: "gh", runChild, repoRoot }, calls, residualPosts };
}
const nonResidual = (actions) => actions.filter((action) => action.step !== "residual_replied");
// --check also requires a live residual-status reply, so a deferred residual root without one is incomplete there (and only there).
const assertCompleteModuloResidual = (result, check) => {
  const residual = result.incomplete.filter((entry) => entry.failedStep === "residual_reply_failed");
  assert.ok(check || residual.length === 0);
  assert.equal(result.incomplete.length, residual.length);
  assert.equal(result.complete, residual.length === 0);
};
const ghCount = (calls) => calls.filter((call) => call.command !== "git").length;

const REF = `fixer:${REPO}#${PR}:${HEAD_SHA}:f1-0000abcd`;

// ADR 0106 delivery evidence for a full-phase fixer: the emit plan, its pull
// receipt under <repoRoot>/tmp, and the disposition handoff at the plan's outputRef.
async function deliver(repoRoot, dispositions, {
  handoffHead = HEAD_SHA, orderHead = HEAD_SHA, phase = "full", receipt = {}, writeReceipt = true, writeHandoff = true, pulledAt = new Date(Date.now() - 1000).toISOString(),
  receiptMtime = null, handoffText = null, actList = null, editActListAfter = false, threads = null, delta = null, decision = null, semanticAuthority = true,
} = {}) {
  const dir = path.join(repoRoot, "tmp", "gate-fixer", "owner-repo", `pr-${PR}`);
  const outputRef = path.join(dir, "f1-0000abcd", "fixer-disposition.json");
  const actListPath = path.join(dir, "act-list.json");
  const workOrder = { role: "fixer", phase, target: { repo: REPO, pr: PR }, headSha: orderHead, mutationAuthority: { branch: "issue-1" }, outputRefs: [outputRef], ...(actList ? { requiredReads: [{ kind: "act-list", path: actListPath, sha256: createHash("sha256").update(JSON.stringify(actList)).digest("hex") }] } : {}) };
  const plan = { workOrderRef: REF, workOrderDigest: workOrderDigest(workOrder), executionIdentity: "f1-0000abcd", workOrder };
  if (threads) {
    const source = path.join(dir, "threads.json");
    workOrder.requiredReads = [{ kind: "threads", path: source, sha256: createHash("sha256").update(JSON.stringify(threads)).digest("hex") }];
    workOrder.authority = { sourceDigest: sha256Hex(threads).slice(7) };
    await mkdir(dir, { recursive: true });
    await writeFile(source, JSON.stringify(threads));
    plan.workOrderDigest = workOrderDigest(workOrder);
  }
  if (delta) {
    const deltaPath = path.join(dir, "delta.json");
    workOrder.requiredReads.push({ kind: "delta-result", path: deltaPath, sha256: createHash("sha256").update(JSON.stringify(delta)).digest("hex") });
    if (semanticAuthority) workOrder.authority = { sourceDigest: sha256Hex(actList).slice(7), deltaResultDigest: sha256Hex(delta).slice(7) };
    await mkdir(dir, { recursive: true });
    await writeFile(deltaPath, JSON.stringify(delta));
    plan.workOrderDigest = workOrderDigest(workOrder);
    if (decision) {
      const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${orderHead}.json`);
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, JSON.stringify(decision));
    }
  }
  const planPath = path.join(dir, "fixer-emit-plan.json");
  await mkdir(path.dirname(outputRef), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  if (actList) await writeFile(actListPath, JSON.stringify(editActListAfter ? [] : actList));
  if (writeReceipt) {
    const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({
      role: "fixer", workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity, pulledAt, subject: { planPath }, ...receipt,
    }));
  }
  if (writeHandoff) await writeFile(outputRef, handoffText ?? JSON.stringify({ headSha: handoffHead, dispositions }));
  if (receiptMtime) {
    await utimes(pullReceiptPath(path.join(repoRoot, "tmp"), REF), receiptMtime, receiptMtime);
    if (writeHandoff) await utimes(outputRef, 1, 1);
  }
  return planPath;
}

async function boundFixture(root, writeHandoff = false, setup = {}) {
  const planPath = await deliver(root, TACKLED, { writeHandoff, ...setup });
  const plan = JSON.parse(await readFile(planPath));
  const prompt = `Historical prose.\n## Work order\n\n\`\`\`json\n${JSON.stringify(plan.workOrder, null, 2)}\n\`\`\`\n`;
  plan.materializationHash = sha256Hex(prompt);
  await mkdir(path.join(path.dirname(planPath), "work-orders"), { recursive: true });
  await writeFile(path.join(path.dirname(planPath), "work-orders", `${plan.executionIdentity}.md`), prompt);
  await writeFile(planPath, JSON.stringify(plan));
  const receiptPath = pullReceiptPath(path.join(root, "tmp"), plan.workOrderRef);
  const subject = { repo: REPO, pr: PR, headSha: HEAD_SHA, branch: "issue-1", phase: "full", planPath };
  await writeFile(receiptPath, JSON.stringify({ ...plan, role: "fixer", subject }));
  if (writeHandoff) await utimes(receiptPath, 1, 1);
  return { plan, planPath, receiptPath, subject };
}

test("bound active full missing output is typed subject evidence and resolver stays incomplete", async () => {
  await withRepoRoot(async (root) => {
    const f = await boundFixture(root);
    const expected = { workOrderRef: f.plan.workOrderRef, workOrderDigest: f.plan.workOrderDigest,
      executionIdentity: f.plan.executionIdentity, planPath: f.planPath, subject: f.subject, outputMissing: true };
    const { deps } = runtime([], root);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.planPath, check: true }, deps),
      (error) => error.code === "FIXER_RESULT_MISSING" && assert.deepEqual(error.activeFixer, expected) === undefined);
    const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
    assert.equal(result.complete, false);
    assert.deepEqual(result.activeFixer, expected);
  });
});

test("emitted and pulled THREAD full binds missing output without an execution directory", async () => {
  await withRepoRoot(async (root) => {
    root = await realpath(root);
    initGitFixture(root, { branch: "issue-1" });
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: gitEnvNoDirOverrides(), encoding: "utf8" }).trim();
    const tmpRoot = path.join(root, "tmp"), threadsFile = path.join(tmpRoot, "threads.json");
    const recordPath = path.join(tmpRoot, "gate-delta", `${head}.json`);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(threadsFile, JSON.stringify({ ok: true, repo: REPO, pr: PR, threads: [{ threadId: "PRRT_T1", isResolved: false }] }));
    await writeFile(recordPath, JSON.stringify({ reviewBaselineHead: head, candidateHead: head, actSetId: "0".repeat(16),
      invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: "PRRT_T1", status: "resolved" }] }));
    const plan = await emitFixerWorkOrder({ repo: REPO, pr: PR, headSha: head, phase: "full", threadsFile, cwd: root,
      fetchPr: async () => ({ headRefName: "issue-1", headRefOid: head }) });
    const pulled = await pullWorkOrder({ ref: plan.workOrderRef, digest: plan.workOrderDigest, execution: plan.executionIdentity,
      cwd: root, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
    assert.equal(pulled.workOrderText, await readFile(plan.promptPath, "utf8"));
    const executionDir = path.dirname(plan.workOrder.outputRefs[0]);
    assert.equal(existsSync(executionDir), false);
    const { deps, calls } = runtime([], root, { live: false });
    const expected = { workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
      planPath: plan.planPath, subject: pulled.receipt.subject, outputMissing: true };
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: head, fixerPlan: plan.planPath, check: true }, deps),
      (error) => error.code === "FIXER_RESULT_MISSING" && assert.deepEqual(error.activeFixer, expected) === undefined);
    const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: head }, deps);
    assert.equal(result.complete, false);
    assert.deepEqual(result.activeFixer, expected);
    assert.equal(existsSync(executionDir), false);
    assert.deepEqual(calls, []);
  });
});

// An emitted and pulled THREAD full plan whose pushed head is the baseline head (issue 2787 C3, C4).
async function threadConstructFixture(root, recordOver) {
  root = await realpath(root);
  initGitFixture(root, { branch: "issue-1" });
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: gitEnvNoDirOverrides(), encoding: "utf8" }).trim();
  const tmpRoot = path.join(root, "tmp"), threadsFile = path.join(tmpRoot, "threads.json");
  const recordPath = path.join(tmpRoot, "gate-delta", `${head}.json`);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(threadsFile, JSON.stringify({ ok: true, repo: REPO, pr: PR, threads: [{ threadId: "PRRT_T1", isResolved: false }] }));
  const record = { reviewBaselineHead: head, candidateHead: head, actSetId: "0".repeat(16),
    invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: "PRRT_T1", status: "resolved" }] };
  await writeFile(recordPath, JSON.stringify(record));
  const plan = await emitFixerWorkOrder({ repo: REPO, pr: PR, headSha: head, phase: "full", threadsFile, cwd: root,
    fetchPr: async () => ({ headRefName: "issue-1", headRefOid: head }) });
  await pullWorkOrder({ ref: plan.workOrderRef, digest: plan.workOrderDigest, execution: plan.executionIdentity, cwd: root, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
  // A variant record replaces the clearing one after emission and pull, which need the clearing record.
  if (recordOver) await (recordOver.missing ? rm(recordPath) : writeFile(recordPath, JSON.stringify({ ...record, ...recordOver })));
  const options = { repo: REPO, pr: PR, headSha: head, fixerPlan: plan.planPath };
  return { plan, options, head, output: plan.workOrder.outputRefs[0], root, runtimeFor: (entries, rollup, extra = {}) => runtime([liveHeadEntry(head, rollup), ...entries], root, { live: false, ...extra }) };
}

test("THREAD full --construct builds the report from the threads, the clearing record and the pushed head, then normal and --check pass", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    const constructed = await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    assert.equal(constructed.constructed, true);
    assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), { headSha: f.head, dispositions: [{ threadId: "PRRT_T1", fixingCommitSha: f.head, disposition: "tackled" }] });
    for (const check of [false, true]) {
      const mock = f.runtimeFor([threadsCallEntry([{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }]), ...ciEntries(f.head), compareEntry(f.head, "identical", f.head)]);
      assert.equal((await verifyFixerDisposition({ ...f.options, check }, mock.deps)).complete, true);
    }
  });
});

for (const route of ["THREAD", "ACT"]) for (const existing of ["report", "marker", "directory", "symlink"]) test(`${route} construction preserves existing ${existing} entries`, async () => {
  await withRepoRoot(async (root) => {
    const f = route === "THREAD" ? await threadConstructFixture(root) : await completionFixture(root);
    const output = f.output ?? f.plan.workOrder.outputRefs[0];
    if (route === "ACT") { await rm(output); await rm(`${output}.constructed`); }
    await mkdir(path.dirname(output), { recursive: true });
    const target = existing === "report" ? output : `${output}.constructed`;
    const saved = path.join(root, "saved");
    await writeFile(saved, "existing bytes");
    if (existing === "directory") await mkdir(target);
    else if (existing === "symlink") await symlink(saved, target);
    else await writeFile(target, "existing bytes");
    const options = f.options ?? { repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan };
    const deps = route === "THREAD" ? f.runtimeFor([threadsCallEntry([])]).deps : f.depsFor().deps;
    await assert.rejects(verifyFixerDisposition({ ...options, construct: true }, deps), /EEXIST/);
    assert.equal(await readFile(saved, "utf8"), "existing bytes");
    if (existing === "directory") assert.ok((await lstat(target)).isDirectory());
    else assert.equal(await readFile(target, "utf8"), "existing bytes");
    if (existing === "report") assert.equal(existsSync(`${output}.constructed`), false);
    if (existing !== "report") await assert.rejects(verifyFixerDisposition({ ...options, check: true }, deps));
  });
});

for (const defect of ["directorySymlink", "outputSymlink", "notDirectory"]) test(`THREAD construction refuses ${defect} before output writes`, async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    const saved = path.join(root, "saved");
    await mkdir(saved);
    await writeFile(path.join(saved, "fixer-disposition.json"), "existing bytes");
    if (defect === "directorySymlink") await symlink(saved, path.dirname(f.output), "dir");
    else {
      await mkdir(path.dirname(f.output));
      if (defect === "outputSymlink") await symlink(path.join(saved, "fixer-disposition.json"), f.output);
      else { await rm(path.dirname(f.output), { recursive: true }); await writeFile(path.dirname(f.output), "existing bytes"); }
    }
    await assert.rejects(verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([]).deps), /canonical execution path|ENOTDIR/);
    assert.equal(await readFile(path.join(saved, "fixer-disposition.json"), "utf8"), "existing bytes");
    assert.equal(existsSync(`${f.output}.constructed`), false);
  });
});

for (const [failed, operation] of [["report", "writeFile"], ["report", "close"], ["marker", "writeFile"], ["marker", "close"], ["report", "link"]]) test(`construction ${failed} ${operation} failure cannot become delivery evidence even when cleanup fails`, async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    const source = await readFile(new URL("../../scripts/github/verify-fixer-disposition.mjs", import.meta.url), "utf8");
    const start = source.indexOf("  if (options.construct) {\n    await mkdir");
    const end = source.indexOf("\n  if (source) {", start);
    assert.ok(start >= 0 && end > start);
    await assert.rejects(runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
      options: { construct: true }, path, mkdir, mkdtemp, lstat, handoffPath: f.output, constructMarkPath: (file) => `${file}.constructed`, sha256Hex,
      link: async (...args) => {
        if (operation === "link") throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
        await link(...args);
      },
      rm: async () => { throw new Error("injected cleanup failure"); },
      constructedReport: { headSha: f.head, dispositions: [{ threadId: "PRRT_T1", fixingCommitSha: f.head, disposition: "tackled" }] },
      open: async (file, flags) => {
        const handle = await open(file, flags);
        const invoke = async (method, args) => {
          await handle[method](...args);
          if (file.endsWith(".constructed") === (failed === "marker") && method === operation) throw Object.assign(new Error("injected output failure"), { code: "EIO" });
          if (file.endsWith(".constructed") === (failed === "marker") && method === "close" && operation === "writeFile") throw new Error("injected secondary close failure");
        };
        return { truncate: async () => { throw new Error("injected cleanup failure"); }, close: () => invoke("close", []), writeFile: (...args) => invoke("writeFile", args) };
      },
    }), (error) => error.code === "FIXER_CONSTRUCTION_FAILED" && error.cause.code === "EIO");
    assert.equal(existsSync(f.output), false);
    await assert.rejects(verifyFixerDisposition({ ...f.options, check: true }, f.runtimeFor([]).deps), /result_missing/);
  });
});

for (const [label, over] of [
  ["a missing record", { missing: true }],
  ["a non-clearing nextStep", { nextStep: "fix_and_rereview" }],
  ["a different candidateHead", { candidateHead: "d".repeat(40) }],
]) {
  test(`THREAD --construct refuses ${label} and writes no output or mark`, async () => {
    await withRepoRoot(async (root) => {
      const f = await threadConstructFixture(root, over);
      const mock = f.runtimeFor([threadsCallEntry([])]);
      await assert.rejects(verifyFixerDisposition({ ...f.options, construct: true }, mock.deps), /needs a clearing delta record/);
      assert.equal(existsSync(f.output), false);
      assert.equal(existsSync(`${f.output}.constructed`), false);
    });
  });
}

test("THREAD full --construct with a pushed candidate later than the order head names the candidate; normal and --check pass", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    execFileSync("git", ["-C", f.root, "commit", "-q", "--allow-empty", "-m", "fix"], { env: gitEnvNoDirOverrides() });
    const pushed = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { env: gitEnvNoDirOverrides(), encoding: "utf8" }).trim();
    const recordPath = path.join(f.root, "tmp", "gate-delta", `${f.head}.json`);
    await writeFile(recordPath, JSON.stringify({ ...JSON.parse(await readFile(recordPath, "utf8")), candidateHead: pushed }));
    const options = { ...f.options, headSha: pushed };
    const mockFor = (entries) => runtime(entries, f.root, { live: false });
    const ahead = compareEntry(f.head, "ahead", pushed);
    const constructed = await verifyFixerDisposition({ ...options, construct: true }, mockFor([ahead, liveHeadEntry(pushed), threadsCallEntry([])]).deps);
    assert.equal(constructed.constructed, true);
    assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), { headSha: pushed, dispositions: [{ threadId: "PRRT_T1", fixingCommitSha: pushed, disposition: "tackled" }] });
    for (const check of [false, true]) {
      const resolved = [{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${pushed}.`, author: { login: "bot", __typename: "User" } }] } }];
      const mock = mockFor([ahead, liveHeadEntry(pushed), threadsCallEntry(resolved), ...ciEntries(pushed), compareEntry(pushed, "identical", pushed)]);
      assert.equal((await verifyFixerDisposition({ ...options, check }, mock.deps)).complete, true);
    }
  });
});

test("a head whose only check run is gate-evidence is settled check-less and accepted", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const resolved = [{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }];
    const mock = f.runtimeFor([threadsCallEntry(resolved), ...ciEntries(f.head, { runs: [{ name: "gate-evidence", status: "completed", conclusion: "success" }] }), compareEntry(f.head, "identical", f.head)]);
    assert.equal((await verifyFixerDisposition(f.options, mock.deps)).complete, true);
  });
});

test("a hand-written fixer-disposition.json with valid content is refused and names --construct", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await mkdir(path.dirname(f.output), { recursive: true });
    await writeFile(f.output, JSON.stringify({ headSha: f.head, dispositions: [{ threadId: "PRRT_T1", fixingCommitSha: f.head, disposition: "tackled" }] }));
    const mock = f.runtimeFor([]);
    await assert.rejects(verifyFixerDisposition(f.options, mock.deps), /not written by this verifier's --construct/);
    assert.equal(mock.calls.length, 0);
  });
});

test("normal mode refuses while the head's checks are red and posts no reply", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const open = [{ id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }] } }];
    const mock = f.runtimeFor([threadsCallEntry(open), ...ciEntries(f.head, { failing: "lint" })]);
    await assert.rejects(verifyFixerDisposition(f.options, mock.deps), /ci_failed.*lint/);
    assert.equal(hasPost(mock.calls), false);
    assert.deepEqual(await checkpointFiles(root), []);
  });
});

for (const [label, ci, expected] of [
  ["pending", { runs: [{ name: "build", status: "in_progress" }] }, /ci_pending.*pending/],
  ["unreadable", { checkRunsExit: 1 }, /ci_unknown.*unreadable/],
  ["cancelled-only", { runs: [{ name: "build", status: "completed", conclusion: "cancelled" }], statuses: [] }, /ci_unknown/],
  ["stale-only", { runs: [{ name: "build", status: "completed", conclusion: "stale" }], statuses: [] }, /ci_unknown/],
  ["status-context failure", { statuses: [{ context: "circle", state: "failure" }] }, /ci_failed.*circle/],
]) {
  test(`normal mode refuses with a ${label} head and posts no reply`, async () => {
    await withRepoRoot(async (root) => {
      const f = await threadConstructFixture(root);
      await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
      const open = [{ id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }] } }];
      const mock = f.runtimeFor([threadsCallEntry(open), ...ciEntries(f.head, ci)]);
      await assert.rejects(verifyFixerDisposition(f.options, mock.deps), expected);
      assert.equal(hasPost(mock.calls), false);
    });
  });
}

test("a failing check run outside the PR rollup is ignored like wait-pr-checks does", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const resolved = [{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }];
    const runs = [{ name: "build", status: "completed", conclusion: "success" }, { name: "codeql", status: "completed", conclusion: "failure" }];
    const mock = f.runtimeFor([threadsCallEntry(resolved), ...ciEntries(f.head, { runs }), compareEntry(f.head, "identical", f.head)], [{ name: "build" }]);
    assert.equal((await verifyFixerDisposition(f.options, mock.deps)).complete, true);
  });
});

test("a hidden cancelled or stale run beside a visible green build does not downgrade to ci_unknown", async () => {
  for (const conclusion of ["cancelled", "stale"]) {
    await withRepoRoot(async (root) => {
      const f = await threadConstructFixture(root);
      await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
      const resolved = [{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }];
      const runs = [{ name: "build", status: "completed", conclusion: "success" }, { name: "hidden", status: "completed", conclusion }];
      const mock = f.runtimeFor([threadsCallEntry(resolved), ...ciEntries(f.head, { runs }), compareEntry(f.head, "identical", f.head)], [{ name: "build" }]);
      assert.equal((await verifyFixerDisposition(f.options, mock.deps)).complete, true);
    });
  }
});

test("a failing check run inside the PR rollup still refuses ci_failed and posts no reply", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const open = [{ id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }] } }];
    const runs = [{ name: "build", status: "completed", conclusion: "success" }, { name: "codeql", status: "completed", conclusion: "failure" }];
    const mock = f.runtimeFor([threadsCallEntry(open), ...ciEntries(f.head, { runs })], [{ name: "build" }, { name: "codeql" }]);
    await assert.rejects(verifyFixerDisposition(f.options, mock.deps), /ci_failed.*codeql/);
    assert.equal(hasPost(mock.calls), false);
  });
});

test("a rollup that lists a real check is not check-less when both commit APIs return zero", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const open = [{ id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }] } }];
    const mock = f.runtimeFor([threadsCallEntry(open), ...ciEntries(f.head, { runs: [] })], [{ name: "build" }]);
    await assert.rejects(verifyFixerDisposition(f.options, mock.deps), /ci_unknown/);
    assert.equal(hasPost(mock.calls), false);
  });
});

test("a hidden pending run beside a visible green run does not block replies on an open thread", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const open = [{ id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }] } }];
    const done = [{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: "please fix", author: { login: "bot", __typename: "User" } }, { id: "c2", databaseId: 2, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }];
    const runs = [{ name: "build", status: "completed", conclusion: "success" }, { name: "codeql", status: "in_progress" }];
    const mock = f.runtimeFor([
      threadsCallEntry(open), ...ciEntries(f.head, { runs }), compareEntry(f.head, "identical", f.head),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/1/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry(done),
    ], [{ name: "build" }]);
    assert.equal((await verifyFixerDisposition(f.options, mock.deps)).complete, true);
    assert.equal(hasPost(mock.calls), true);
  });
});

test("a settled head with no check runs and no statuses is accepted", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root);
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    for (const check of [false, true]) {
      const mock = f.runtimeFor([threadsCallEntry([{ id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 1, body: `Fixed in commit ${f.head}.`, author: { login: "bot", __typename: "User" } }] } }]), ...ciEntries(f.head, { runs: [] }), compareEntry(f.head, "identical", f.head)]);
      assert.equal((await verifyFixerDisposition({ ...f.options, check }, mock.deps)).complete, true);
    }
  });
});

for (const defect of ["partialSubject", "subjectHead", "receipt", "prompt", "digest", "ref", "role", "target", "output", "directory", "danglingReport", "redirectedDirectory", "danglingDirectory", "notDirectory", "malformed", "prePull"]) {
  test(`active full binding withholds metadata for ${defect}`, async () => {
    await withRepoRoot(async (root) => {
      const f = await boundFixture(root);
      const output = f.plan.workOrder.outputRefs[0], dir = path.dirname(output);
      const receipt = JSON.parse(await readFile(f.receiptPath));
      if (defect === "partialSubject") receipt.subject = { planPath: f.planPath };
      if (defect === "subjectHead") receipt.subject.headSha = FIX_SHA;
      if (defect === "receipt") receipt.workOrderDigest = `sha256:${"0".repeat(64)}`;
      await writeFile(f.receiptPath, JSON.stringify(receipt));
      if (defect === "prompt") await writeFile(path.join(path.dirname(f.planPath), "work-orders", `${f.plan.executionIdentity}.md`), "changed");
      if (defect === "digest") f.plan.workOrderDigest = `sha256:${"0".repeat(64)}`;
      if (defect === "ref") f.plan.workOrderRef += ":copied";
      if (defect === "role") f.plan.workOrder.role = "review";
      if (defect === "target") f.plan.workOrder.target.pr++;
      if (defect === "output") f.plan.workOrder.outputRefs[0] = path.join(root, "copied.json");
      await writeFile(f.planPath, JSON.stringify(f.plan));
      if (defect === "directory") await mkdir(output);
      if (defect === "danglingReport") await symlink(path.join(root, "absent"), output);
      if (["redirectedDirectory", "danglingDirectory", "notDirectory"].includes(defect)) {
        await rm(dir, { recursive: true });
        const target = path.join(root, "redirected");
        if (defect === "redirectedDirectory") await mkdir(target);
        if (defect === "notDirectory") await writeFile(dir, "file");
        else await symlink(target, dir);
      }
      if (["malformed", "prePull"].includes(defect)) {
        await writeFile(output, defect === "malformed" ? "{" : JSON.stringify({ headSha: HEAD_SHA, dispositions: TACKLED }));
        if (defect === "prePull") await utimes(output, 1, 1);
      }
      const { deps } = runtime([], root);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.planPath, check: true }, deps),
        (error) => error.code !== "FIXER_RESULT_MISSING" && error.activeFixer === undefined);
      assert.equal((await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps)).activeFixer, undefined);
    });
  });
}

test("checked incomplete binds false only after live checks and canonical byte recheck", async () => {
  await withRepoRoot(async (root) => {
    const f = await boundFixture(root, true);
    for (const supersede of [false, true]) {
      const { deps } = runtime([threadsCallEntry([]), compareEntry(FIX_SHA, "diverged")], root);
      const run = deps.runChild;
      deps.runChild = async (...args) => {
        const result = await run(...args);
        if (supersede && args[1].some((arg) => String(arg).includes("/compare/"))) await writeFile(f.planPath, `${JSON.stringify(f.plan)}\n`);
        return result;
      };
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
      assert.equal(result.complete, false);
      assert.equal(result.incomplete[0].failedStep, "commit_not_contained");
      assert.deepEqual(result.activeFixer, supersede ? undefined : { workOrderRef: f.plan.workOrderRef, workOrderDigest: f.plan.workOrderDigest,
        executionIdentity: f.plan.executionIdentity, planPath: f.planPath, subject: f.subject, outputMissing: false });
    }
  });
});

test("missing binding preserves original A subject at observed B and refuses resolver supersession", async () => {
  await withRepoRoot(async (root) => {
    const f = await boundFixture(root);
    for (const supersede of [false, true]) {
      const { deps } = runtime([compareEntry(HEAD_SHA, "ahead", FIX_SHA)], root, { live: false });
      const run = deps.runChild;
      deps.runChild = async (...args) => {
        const result = await run(...args);
        if (supersede) await writeFile(f.planPath, `${JSON.stringify(f.plan)}\n`);
        return result;
      };
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: FIX_SHA }, deps);
      assert.equal(result.complete, false);
      assert.equal(result.activeFixer?.subject.headSha, supersede ? undefined : HEAD_SHA);
      assert.equal(result.activeFixer?.outputMissing, supersede ? undefined : true);
    }
  });
});

test("missing subject evidence does not authenticate the ACT source or authorize completion", async () => {
  await withRepoRoot(async (root) => {
    const f = await boundFixture(root, false, { actList: [{ fingerprint: "fp1" }] });
    await writeFile(f.plan.workOrder.requiredReads[0].path, "[]");
    const options = { repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.planPath, check: true };
    await assert.rejects(verifyFixerDisposition(options, runtime([], root).deps), { code: "FIXER_RESULT_MISSING" });
    await writeFile(f.plan.workOrder.outputRefs[0], JSON.stringify({ headSha: HEAD_SHA, dispositions: TACKLED }));
    await assert.rejects(verifyFixerDisposition(options, runtime([], root).deps), /act list.*sha256/);
  });
});

for (const code of ["EACCES", "EIO", "ENOTDIR", "ELOOP"]) for (const target of ["report", "directory"]) test(`actual missing branch keeps ${target} ${code} unbound`, async () => {
  await withRepoRoot(async (root) => {
    const f = await boundFixture(root);
    let injected = 0;
    const source = await readFile(new URL("../../scripts/github/verify-fixer-disposition.mjs", import.meta.url), "utf8");
    const failingPath = target === "report" ? f.plan.workOrder.outputRefs[0] : await realpath(path.dirname(f.plan.workOrder.outputRefs[0]));
    const context = Object.assign({ Buffer, JSON, path, readFile, realpath,
      lstat: async (file) => { if (file === failingPath) { injected++; throw Object.assign(new Error(code), { code }); } return lstat(file); },
    }, await import("../../scripts/github/_work-order-protocol.mjs"), await import("../../scripts/github/_fixer-emission-evidence.mjs"),
    await import("../../scripts/github/_gate-artifact-paths.mjs"), await import("../../scripts/lib/head-sha.mjs"));
    const load = runInNewContext(`${source.slice(source.indexOf("async function loadDeliveredHandoff"), source.indexOf("// Builds the { threadId"))}\nloadDeliveredHandoff`, context);
    await assert.rejects(load({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.planPath },
      { repoRoot: root, receiptTmpRoot: path.join(root, "tmp"), runtime: {} }), (error) => !error.code && !error.activeFixer && /result_missing/.test(error.message));
    assert.equal(injected, 1, "the authenticated missing branch must reach the lstat failure");
  });
});

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

test("parseVerifyFixerDispositionCliArgs requires repo/pr/head-sha/fixer-plan", () => {
  assert.throws(() => parseVerifyFixerDispositionCliArgs(["--repo", REPO]), /Missing required arguments/);
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", HEAD_SHA]),
    /Missing required arguments: fixerPlan/,
  );
});

test("parseVerifyFixerDispositionCliArgs rejects a short head SHA", () => {
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", "abc1234"]),
    /FULL head commit SHA/,
  );
});

test("F6: a caller-supplied --dispositions or --dispositions-file is rejected", () => {
  for (const flag of ["--dispositions", "--dispositions-file"]) {
    assert.throws(
      () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", HEAD_SHA, "--fixer-plan", "p.json", flag, "[]"]),
      /Unknown argument/,
    );
  }
});

// ---------------------------------------------------------------------------
// F6 — delivery evidence: receipt + handoff + observed head, or no advance
// ---------------------------------------------------------------------------

const TACKLED = [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }];

for (const check of [false, true]) for (const [name, setup, expected] of [
  ["a missing receipt", { writeReceipt: false }, /receipt_missing/],
  ["a malformed receipt", { receipt: { workOrderRef: 7 } }, /unit_mismatch/],
  ["a receipt for another role", { receipt: { role: "review" } }, /role_mismatch/],
  ["a receipt for another execution", { receipt: { executionIdentity: "f2-0000abcd" } }, /execution_mismatch/],
  ["a receipt for another digest", { receipt: { workOrderDigest: "e".repeat(64) } }, /digest_mismatch/],
  ["a receipt without a handoff (receipt-only)", { writeHandoff: false }, /result_missing/],
  ["a prose-only handoff", { handoffText: "Fixed all threads." }, /is not valid JSON/],
  ["a handoff with a malformed dispositions list", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: "x" }) }, /dispositions must be an array/],
  ["a handoff written before the pull (stale or replayed)", { receiptMtime: new Date("2000-01-01T00:00:00Z") }, /result_predates_pull/],
  ["a handoff whose head is not the observed head", { handoffHead: FIX_SHA }, /not the observed head/],
  ["a commit_only plan", { phase: "commit_only" }, /not a full-phase fixer work order/],
  ["an act item with a siteQuery and no coverage record", { actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] }, /act item fp1 has a site query and no site coverage record/],
  ["an act list edited after emission", { editActListAfter: true, actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] }, /differs from the sha256 the work order binds/],
  ["a handoff leaving a returned site neither fixed nor skipped", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [{ threadId: "PRRT_kwDOabc", fixingCommitSha: FIX_SHA, disposition: "tackled", returnedSites: ["src/a.mjs:guard", "src/b.mjs:guard"], sites: [{ site: "src/a.mjs:guard", status: "fixed" }] }] }) }, /leaves returned site src\/b\.mjs:guard neither fixed nor skipped/],
  ["a handoff skipping a returned site without a reason", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [{ threadId: "PRRT_kwDOabc", fixingCommitSha: FIX_SHA, disposition: "tackled", returnedSites: ["src/a.mjs:guard"], sites: [{ site: "src/a.mjs:guard", status: "skipped" }] }] }) }, /records no skip reason/],
]) {
  test(`F6 (${check ? "check" : "default"}): ${name} refuses and writes no checkpoint`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, TACKLED, setup);
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), expected);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(path.join(repoRoot, "tmp", "gate-findings")), false);
    });
  });
}

test("F6: a handoff written in the same clock tick as the pull (equal mtimes) passes verifyPulledResult", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const receiptTmpRoot = path.join(repoRoot, "tmp");
    const tick = new Date(Date.now() - 5000);
    await utimes(pullReceiptPath(receiptTmpRoot, REF), tick, tick);
    await utimes(plan.workOrder.outputRefs[0], tick, tick);
    const check = await verifyPulledResult({
      resultPath: plan.workOrder.outputRefs[0], receiptTmpRoot, role: "fixer", workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
    });
    assert.equal(check.ok, true, check.reason);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan for another target, or a missing plan, refuses`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const { deps } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR + 1, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /not a full-phase fixer work order for owner\/repo#1976/);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: "nope.json", tmpRoot: "tmp", check }, deps), /Cannot read --fixer-plan/);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a work order head not contained by the observed head refuses; a contained one passes and the checkpoint records delivery`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const orderHead = "c".repeat(40);
    const fixerPlan = await deliver(repoRoot, [], { orderHead });
    const diverged = runtime([compareEntry(orderHead, "diverged")], repoRoot, { live: false });
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, diverged.deps), /not contained by the observed head/);
    const ahead = runtime([compareEntry(orderHead, "ahead"), liveHeadEntry(), threadsCallEntry([])], repoRoot, { live: false });
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, ahead.deps);
    assert.equal(result.complete, true);
    if (check) { assert.equal(result.checkpointPath, null); assert.deepEqual(await checkpointFiles(repoRoot), []); return; }
    const checkpoint = JSON.parse(await readFile(path.join(repoRoot, result.checkpointPath), "utf8"));
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    assert.deepEqual(
      { workOrderRef: checkpoint.workOrderRef, workOrderDigest: checkpoint.workOrderDigest, executionIdentity: checkpoint.executionIdentity },
      { workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: "f1-0000abcd" },
    );
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan whose work order was edited in place after emission refuses before any read`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    for (const workOrder of [{ ...plan.workOrder, mutationAuthority: { branch: "main" } }, { ...plan.workOrder, headSha: FIX_SHA }]) {
      await writeFile(fixerPlan, JSON.stringify({ ...plan, workOrder }));
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /does not match its workOrderDigest/);
      assert.equal(calls.length, 0);
    }
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): an outputRef edited in place (outside the digest) refuses; the handoff is never read from it`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const forged = path.join(repoRoot, "forged.json");
    await writeFile(forged, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    await writeFile(fixerPlan, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, outputRefs: [forged] } }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /is not the emitted handoff path/);
    assert.equal(calls.length, 0);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan copied to another directory with a matching outputRef refuses; the pulled plan location is bound`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const copyDir = path.join(repoRoot, "x");
    const forged = path.join(copyDir, plan.executionIdentity, "fixer-disposition.json");
    await mkdir(path.dirname(forged), { recursive: true });
    await writeFile(forged, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    const copied = path.join(copyDir, "fixer-emit-plan.json");
    await writeFile(copied, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, outputRefs: [forged] } }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: copied, tmpRoot: "tmp", check }, deps), /is not the plan the fixer pull read/);
    assert.equal(calls.length, 0);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a --head-sha other than the live PR head refuses before any checkpoint write`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const { deps } = runtime([liveHeadEntry(FIX_SHA)], repoRoot, { live: false });
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /is not the live PR head b{40}/);
    assert.equal(existsSync(path.join(repoRoot, "tmp", "gate-findings")), false);
  });
});

// ---------------------------------------------------------------------------
// AC row 3 — ordering integration: commit -> containment -> reply -> resolve -> reread
// ---------------------------------------------------------------------------

test("records a checkpoint, replies+resolves a tackled thread with missing evidence, and reports complete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.incomplete, []);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].step, "replied_and_resolved");
    assert.equal(calls.length, 6);

    const checkpointRaw = await readFile(path.join(repoRoot, result.checkpointPath), "utf8");
    const checkpoint = JSON.parse(checkpointRaw);
    assert.equal(checkpoint.headSha, HEAD_SHA);
    assert.equal(checkpoint.dispositions[0].threadId, "PRRT_T1");
  });
});

// ---------------------------------------------------------------------------
// AC row 2 — uncontained commit blocks; no mutation is ever attempted
// ---------------------------------------------------------------------------

for (const check of [false, true]) test(`uncontained commit stays incomplete and never triggers a reply/resolve mutation (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "diverged"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps);

    assert.equal(result.complete, false);
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0].failedStep, "commit_not_contained");
    assert.equal(result.actions.length, 0);
    // Exactly the 3 read-only calls (live head + threads capture + compare) — no reply/resolve/re-read.
    assert.equal(calls.length, 3);
    assert.ok(result.forbiddenActions.includes("request_copilot_review"));
    assert.ok(result.forbiddenActions.includes("rerequest_copilot_review"));
  });
});

// ---------------------------------------------------------------------------
// AC row 5/7 — idempotent re-entry: no duplicate evidence reply
// ---------------------------------------------------------------------------

test("re-entry after reply-succeeded/resolve-failed only resolves, never posts a second reply", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    // First run: reply succeeds, then the mock's resolveReviewThread call
    // reports the thread as NOT resolved (simulating a resolve failure).
    const first = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: false } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const firstResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, first.deps);
    assert.equal(firstResult.complete, false);
    assert.equal(firstResult.incomplete[0].failedStep, "not_resolved");
    assert.equal(firstResult.actions[0].ok, false);

    // Second run (re-entry with the same plan): re-verifies the receipt, sees
    // the reply already carries the commit evidence live, and must ONLY call
    // resolveThread — never postReply again.
    const second = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const secondResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, second.deps);
    assert.equal(secondResult.complete, true);
    assert.equal(secondResult.actions[0].step, "resolved");
    // No POST .../replies call anywhere in this run's gh call log.
    assert.ok(second.calls.every((call) => !call.args.some((arg) => String(arg).includes("/replies"))));
  });
});

// ---------------------------------------------------------------------------
// copilot review (PR #2126): a NOT_RESOLVED entry needs only threadId to
// resolve — a missing/filtered REST commentId (e.g. planBatchReplyTargets
// never matches one because the evidenced reply's author has no login) must
// never block a resolve-only action.
// ---------------------------------------------------------------------------

test("resolve-only path (NOT_RESOLVED) proceeds via threadId alone when no commentId is matched", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture: T1 already carries the commit-evidenced
      // reply, but its author has no login (e.g. a deleted GitHub account),
      // so authorMatchesFilter("all") filters it out and planBatchReplyTargets
      // never matches a commentId for T1. This is NOT_RESOLVED only — no
      // reply is missing — so no commentId should ever be required.
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. resolve GraphQL mutation — no reply POST at all.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 4. re-read live threads
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, true);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].ok, true);
    assert.equal(result.actions[0].step, "resolved");
    // No POST .../replies call anywhere in this run's gh call log.
    assert.ok(calls.every((call) => !call.args.some((arg) => String(arg).includes("/replies"))));
    assert.equal(calls.length, 5);
  });
});

// ---------------------------------------------------------------------------
// AC row 5 — resolve success / re-read failure: the resolve mutation LIES
// (reports isResolved:true) but the post-mutation live re-read still shows
// the thread unresolved; the CLI must trust the re-read, not the mutation.
// ---------------------------------------------------------------------------

test("resolve mutation reports isResolved:true but the live re-read still shows unresolved, so it stays incomplete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation LIES: reports isResolved:true.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads: still unresolved despite the mutation's claim.
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, false);
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0].failedStep, "not_resolved");
    // The mutation itself didn't throw (it claimed success) ...
    assert.equal(result.actions[0].ok, true);
    // ... but the CLI re-fetched live rather than trusting that claim, so
    // overall completion still reflects the true unresolved state.
    assert.equal(calls.length, 6);
  });
});

// ---------------------------------------------------------------------------
// AC row 6 — unrelated threads are never touched
// ---------------------------------------------------------------------------

test("deferred/foreign/newly-arrived threads are never replied to or resolved", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
      { threadId: "PRRT_T2", fixingCommitSha: FIX_SHA, disposition: "deferred" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
        { id: "PRRT_T2", isResolved: false, comments: { nodes: [{ id: "c2", databaseId: 201, body: "unrelated nit", author: { login: "someone-else", __typename: "User" } }] } },
        { id: "PRRT_T3", isResolved: false, comments: { nodes: [{ id: "c3", databaseId: 301, body: "brand new finding", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "identical"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    // Only the read-only calls (live head + threads capture + one compare) — T2/T3 never touched.
    assert.equal(calls.length, 3);
  });
});

test("site coverage riding a fingerprinted thread entry satisfies the act item's siteQuery", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled", fingerprint: "fp1", returnedSites: ["s"], sites: [{ site: "s", status: "fixed" }] },
    ], { actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] });
    const { deps } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
      { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "gate" })}\n` },
      compareEntry(FIX_SHA, "identical"),
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
  });
});

// ---------------------------------------------------------------------------
// main-anchored checkpoint and receipt root
// ---------------------------------------------------------------------------

test("the checkpoint and receipt root default to the main worktree's tmp/ and a --tmp-root in a linked worktree is refused", async () => {
  await withRepoRoot(async (dir) => {
    const main = path.join(await realpath(dir), "main");
    await mkdir(main);
    initGitFixture(main);
    const linked = path.join(main, "tmp/worktrees/dev-loops/issue-1");
    execFileSync("git", ["worktree", "add", "-q", "-b", "issue-1", linked], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    const fixerPlan = await deliver(main, []);
    const { deps } = runtime([threadsCallEntry([])], linked);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan }, deps);
    assert.ok(result.checkpointPath.startsWith(path.join(main, "tmp", "gate-findings")), result.checkpointPath);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, runtime([], linked).deps),
      /inside the linked worktree/,
    );
  });
});

// ---------------------------------------------------------------------------
// fixed-reply guard: a delta record that marks the thread not_resolved blocks the "Fixed in commit" reply
// ---------------------------------------------------------------------------

test("a thread the applicable delta record marks not_resolved gets no Fixed reply and is reported incomplete with its delta status", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${"c".repeat(40)}.json`);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify({
      reviewBaselineHead: "c".repeat(40), candidateHead: FIX_SHA, actSetId: "0".repeat(16), invocation: 1,
      outcome: "needs_fix", nextStep: "fix_and_rereview", items: [{ ref: "PRRT_T1", status: "not_resolved" }],
    }));
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, false);
    assert.deepEqual(result.incomplete.map((entry) => [entry.threadId, entry.failedStep]), [["PRRT_T1", "delta_blocked"]]);
    assert.equal(result.incomplete[0].deltaStatus, "not_resolved");
    assert.equal(result.incomplete[0].deltaRecord, recordPath);
    assert.deepEqual(nonResidual(result.actions), []);
    assert.equal(calls.some((call) => call.args.includes("POST")), false, "no reply was posted");
  });
});

// ---------------------------------------------------------------------------
// fixed-reply guard on the verifier: acceptance side, abbreviated SHAs, git failures
// ---------------------------------------------------------------------------

async function writeDeltaRecord(repoRoot, { baseline = "c".repeat(40), candidate = FIX_SHA, items }) {
  const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${baseline}.json`);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify({
    reviewBaselineHead: baseline, candidateHead: candidate, actSetId: "0".repeat(16), invocation: 1,
    outcome: "needs_fix", nextStep: "fix_and_rereview", items,
  }));
  return recordPath;
}

// Wraps the gh mock with a scripted git: `git(args)` returns { code, stdout } for rev-parse / merge-base.
function runtimeWithGit(entries, repoRoot, git) {
  const { deps, calls } = runtime(entries, repoRoot);
  const inner = deps.runChild;
  deps.runChild = async (cmd, args = [], ...rest) => {
    if (cmd === "git" && (args[0] === "rev-parse" || args[0] === "merge-base")) {
      calls.push({ command: cmd, args: [...args], stdinText: "" });
      return { stderr: "", stdout: "", ...git(args) };
    }
    return inner(cmd, args, ...rest);
  };
  return { deps, calls };
}

const unresolvedT1 = () => threadsCallEntry([
  { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
]);
const hasPost = (calls) => calls.some((call) => call.args.includes("POST"));

test("check mode refuses a tackled thread absent live and THREAD ignores unrelated live threads", async () => {
  await withRepoRoot(async (repoRoot) => {
    let fixerPlan = await deliver(repoRoot, TACKLED);
    let mock = runtime([threadsCallEntry([]), compareEntry(FIX_SHA, "ahead")], repoRoot);
    const missing = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, mock.deps);
    assert.equal(missing.complete, false);
    assert.equal(missing.incomplete[0].failedStep, "reply_missing");
    fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_SOURCE", fixingCommitSha: FIX_SHA, disposition: "deferred" }], { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } });
    mock = runtime([threadsCallEntry([actThread("PRRT_UNRELATED", [gateComment("c1", 101)])])], repoRoot);
    const narrow = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, mock.deps);
    assert.equal(narrow.complete, true);
    assert.equal(mock.calls.length, 2, "only live head and threads, no ACT/login/history reads");
  });
});

for (const [isResolved, reply, expected] of [[true, true, null], [false, false, "reply_missing"], [false, true, "not_resolved"]]) {
  test(`check mode preserves report/checkpoint bytes and times with ${expected ?? "complete"} live evidence`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, TACKLED);
      const output = JSON.parse(await readFile(fixerPlan, "utf8")).workOrder.outputRefs[0];
      const checkpoint = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      for (const existing of [false, true]) {
        if (existing) { await mkdir(path.dirname(checkpoint), { recursive: true }); await writeFile(checkpoint, "existing checkpoint\n"); }
        const paths = [fixerPlan, output, pullReceiptPath(path.join(repoRoot, "tmp"), REF), ...(existing ? [checkpoint] : [])];
        const snapshot = async () => Promise.all(paths.map(async (file) => [await readFile(file, "utf8"), (await stat(file)).mtimeMs]));
        const before = await snapshot();
        const { deps, calls } = runtime([threadsCallEntry([actThread("PRRT_T1", [gateComment("c1", 101, reply ? `Fixed in commit ${FIX_SHA}.` : "fix")], isResolved)]), compareEntry(FIX_SHA, "ahead")], repoRoot);
        const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
        assert.equal(result.complete, !expected);
        assert.deepEqual(result.incomplete.map((entry) => entry.failedStep), expected ? [expected] : []);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal(result.checkpointPath, null);
        assert.deepEqual(await snapshot(), before);
        assert.equal(existsSync(path.dirname(checkpoint)), existing, "check creates no checkpoint directory");
        assert.equal(calls.some((call) => call.args.includes("POST") || call.args.some((arg) => String(arg).includes("mutation"))), false);
      }
    });
  });
}

test("check CLI flag is explicit and Delta refusal survives check mode", async () => {
  assert.equal(parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", String(PR), "--head-sha", HEAD_SHA, "--fixer-plan", "p", "--check"]).check, true);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "cannot_verify" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
    assert.equal(result.incomplete[0].failedStep, "delta_blocked");
    assert.deepEqual(nonResidual(result.actions), []);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(calls), false);
  });
});

for (const check of [false, true]) for (const missing of [false, true]) {
  test(`THREAD source hash and membership are enforced (${check}, missing=${missing})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } });
      const read = JSON.parse(await readFile(fixerPlan, "utf8")).workOrder.requiredReads[0];
      if (!missing) await writeFile(read.path, '{"threads":[]}');
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), missing ? /no disposition entry.*PRRT_SOURCE/ : /sha256/);
      assert.equal(calls.length, 0, "THREAD never queries ACT, login or history");
    });
  });
}

for (const check of [false, true]) test(`THREAD canonical source digest is enforced (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { threads: { threads: [] } });
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    plan.workOrder.authority.sourceDigest = "0".repeat(64);
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    await writeFile(fixerPlan, JSON.stringify(plan));
    const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: plan.workOrderDigest }));
    await writeFile(plan.workOrder.outputRefs[0], JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), /threads.*sourceDigest/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
});

test("authentically threadless ACT with complete existing coverage remains valid in check mode", async () => {
  await withRepoRoot(async (repoRoot) => {
    const actList = [{ ...ACT_LIST[0], siteQuery: "git grep x" }];
    const fixerPlan = await deliver(repoRoot, [], { actList, handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [], siteCoverage: [{ fingerprint: ACT_FP, returnedSites: [], sites: [], noSitesReason: "no matches" }] }) });
    const { deps } = runtime([threadsCallEntry([]), userEntry], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
    assert.equal(result.complete, true);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
});

for (const checkpoint of [false, true]) test(`successful active check preserves existing ${checkpoint ? "malformed checkpoint" : "not_verified fallback"}`, async () => {
  await withRepoRoot(async (repoRoot) => {
    await deliver(repoRoot, TACKLED);
    if (checkpoint) {
      const file = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{");
    }
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_T1", [gateComment("c1", 1, `Fixed in commit ${FIX_SHA}.`)], true)]), compareEntry(FIX_SHA, "ahead")], repoRoot);
    const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
    assert.equal(result.complete, false);
    assert.match(result.incomplete[0].failedStep, checkpoint ? /unreadable_checkpoint/ : /not_verified/);
  });
});

test("a failing lazy thread loader makes a checkpoint disposition incomplete instead of throwing", async () => {
  await withRepoRoot(async (repoRoot) => {
    const checkpoint = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(checkpoint, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    const { deps } = runtime([], repoRoot);
    const parsedThreads = async () => { throw new Error("HTTP 502"); };
    const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA, parsedThreads }, deps);
    assert.equal(result.complete, false);
    assert.match(result.incomplete[0].failedStep, /unverified_threads: HTTP 502/);
    assert.equal(result.nextAction, null);
  });
});

for (const hasCheckpoint of [false, true]) for (const [name, setup, expected] of [
  ["missing output", { writeHandoff: false }, /result_missing/],
  ["empty THREAD output", { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } }, /PRRT_SOURCE/],
  ["omitted authenticated ACT thread", { actList: [{ fingerprint: fingerprintFinding({ summary: "s" }), severity: "medium", summary: "s", judgeDisposition: "act" }] }, /PRRT_ACT/],
  ["malformed output", { handoffText: "{" }, /not valid JSON/],
  ["stale head", { handoffHead: FIX_SHA }, /not the observed head/],
  ["predates pull", { receiptMtime: new Date("2000-01-01T00:00:00Z") }, /result_predates_pull/],
]) {
  test(`active full obligation vetoes ${hasCheckpoint ? "empty" : "absent"} checkpoint: ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      await deliver(repoRoot, [], setup);
      const checkpoint = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      if (hasCheckpoint) {
        await mkdir(path.dirname(checkpoint), { recursive: true });
        await writeFile(checkpoint, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
      }
      const { deps, calls } = runtime(setup.actList ? [threadsCallEntry([actThread("PRRT_ACT", [gateComment("c1", 101)])]), userEntry] : [], repoRoot);
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
      assert.equal(result.complete, false);
      assert.match(result.incomplete[0].failedStep, expected);
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const [name, change, compare, expected] of [
  ["foreign target", (order) => { order.target.pr++; }, null, null],
  ["commit_only", (order) => { order.phase = "commit_only"; }, null, null],
  ["unrelated head", (order) => { order.headSha = FIX_SHA; }, "diverged", null],
  ["uncertain containment", (order) => { order.headSha = FIX_SHA; }, "unknown", /unexpected compare status/],
  ["contained order head", (order) => { order.headSha = FIX_SHA; }, "ahead", /result_missing/],
  ["invalid digest", (order) => { order.phase = "commit_only"; }, null, /workOrderDigest/],
]) {
  test(`active plan applicability: ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { writeHandoff: false });
      const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
      change(plan.workOrder);
      if (name !== "invalid digest") plan.workOrderDigest = workOrderDigest(plan.workOrder);
      await writeFile(fixerPlan, JSON.stringify(plan));
      const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: plan.workOrderDigest }));
      const { deps } = runtime(compare ? [compareEntry(FIX_SHA, compare)] : [], repoRoot, { live: false });
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
      if (expected) { assert.equal(result.complete, false); assert.match(result.incomplete[0].failedStep, expected); }
      else assert.equal(result, null);
    });
  });
}

test("an abbreviated fixingCommitSha resolving to a commit a not_resolved record covers gets no Fixed reply", async () => {
  await withRepoRoot(async (repoRoot) => {
    const short = FIX_SHA.slice(0, 10);
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: short, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(short, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 0 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, false);
    assert.deepEqual(result.incomplete.map((entry) => [entry.threadId, entry.failedStep, entry.deltaStatus]), [["PRRT_T1", "delta_blocked", "not_resolved"]]);
    assert.doesNotMatch(result.reason, /reply_missing/);
    assert.match(result.reason, /delta_blocked[^]*fix it, re-run the delta review/);
    assert.equal(hasPost(calls), false);
  });
});

test("a cannot_verify record blocks the Fixed reply and reports the delta status", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "cannot_verify" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "cannot_verify"]]);
    assert.equal(hasPost(calls), false);
  });
});

test("a fixingCommitSha git cannot resolve fails closed while a blocking record exists", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 1 } : { code: 0 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.incomplete[0]?.failedStep, "delta_blocked");
    assert.equal(hasPost(calls), false);
  });
});

test("git merge-base exit 128 (object missing) fails closed instead of reading as not covered", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 128 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.incomplete[0]?.failedStep, "delta_blocked");
    assert.equal(hasPost(calls), false);
  });
});

test("a record whose baseline..candidate range excludes the fixing commit still lets the Fixed reply post", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      unresolvedT1(),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot, (args) => (args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 1 }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(calls), true);
  });
});

test("a resolved delta item for the thread still lets the Fixed reply post", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "resolved" }, { ref: "PRRT_T2", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      unresolvedT1(),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(calls), true);
  });
});

test("a not_resolved delta record also blocks resolving a thread whose Fixed reply already exists", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "not_resolved"]]);
    assert.deepEqual(nonResidual(result.actions), []);
    assert.equal(calls.some((call) => call.args.includes("graphql") && call.args.some((arg) => String(arg).includes("resolveReviewThread"))), false, "thread was not resolved");
  });
});

test("the finding marker is found on any comment of the thread, not only the id-first one", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "0123456789abcdef", status: "not_resolved" }] });
    const { deps } = runtimeWithGit([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [
          { id: "c2", databaseId: 200, body: "<!-- dev-loops:finding 0123456789abcdef -->\nroot", author: { login: "reviewer", __typename: "User" } },
          { id: "c1", databaseId: 100, body: "earlier id, no marker", author: { login: "reviewer", __typename: "User" } },
        ] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "not_resolved"]]);
  });
});

const ACT_FP = fingerprintFinding({ severity: "medium", summary: "s", judgeDisposition: "act" });
const ACT_MARKER = `<!-- dev-loops:finding ${ACT_FP} severity=medium angle=correctness round=1 -->`;
const ACT_LIST = [{ fingerprint: ACT_FP, severity: "medium", summary: "s", judgeDisposition: "act" }];
const userEntry = { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "gate" })}\n` };
// Head CI reads (check-runs, then statuses) the verifier makes before it writes, replies or resolves.
const ciEntries = (head, { failing, runs, statuses = [], checkRunsExit = 0 } = {}) => [
  { assertArgs: ["api", `repos/${REPO}/commits/${head}/check-runs?per_page=100`], exitCode: checkRunsExit, stdout: JSON.stringify({ check_runs: runs ?? [failing ? { name: failing, status: "completed", conclusion: "failure" } : { name: "build", status: "completed", conclusion: "success" }] }) },
  { assertArgs: ["api", `repos/${REPO}/commits/${head}/status?per_page=100`], stdout: JSON.stringify({ statuses }) },
];
// A report as the verifier's own --construct leaves it: the bytes plus the sha256 mark beside them.
const writeMarked = async (file, text) => { await writeFile(file, text); await writeFile(`${file}.constructed`, sha256Hex(text)); };
const gateComment = (id, databaseId, body = `${ACT_MARKER}\n**Problem:** s`, login = "gate") => ({ id, databaseId, body, author: { login, __typename: "User" } });
const actThread = (id, comments, isResolved = false) => ({ id, isResolved, comments: { nodes: comments } });

test("ACT thread selector preserves the genuine public root and complete synthetic memberships", () => {
  // Genuine public PR2762 specimen; transformed variants below are synthetic and grant no mutation authority.
  const root = {
    id: "PRRC_kwDOScHU787-fIpP", databaseId: "4269574735", threadId: "PRRT_kwDOScHU786sRK_N",
    author: { login: "mfittko", type: "User", isBot: false }, isActionable: true,
    body: "<!-- dev-loops:finding 09a9db735031d233 severity=medium angle=correctness round=2 -->\n**medium** · correctness · judge: act\n`scripts/github/_validation-evidence.mjs:78`\n**Problem:** Existing prefix-file contexts with configured validation now fail reviewer admission. The previous write-gate-context producer records scope.validationResultsPath under --prefix-file but omits the validation requiredRead; the previous sentinel accepts that shape.\n**Fix:** Preserve admission of the legacy configured prefix-file shape while keeping the full binding mandatory for not_configured; add a fixture using the old producer-shaped context rather than only the new writer's output.\n<details><summary>Details</summary>\n\n**Problem (continued):** The new sentinel calls this reader, which requires exactly one hash-bound read before checking the record's status, so a valid current-head complete/failed/incomplete legacy artifact is refused as missing binding and blocks semantic participation. Adding the read to the new producer does not preserve compatibility with existing producer-shaped contexts.\n\n**Failing case:** Use a context produced by the old write-gate-context --prefix-file --validation-results path with valid current-head configured evidence, then run the new verify-fresh-review-context: reads.length is zero and admission refuses.\n\n</details>",
  };
  const thread = { id: root.threadId, isResolved: false, reviewId: "PRR_kwDOScHU788AAAABSM6fIw", isActionable: true,
    commentIds: [root.id], commentDatabaseIds: [root.databaseId], actionableCommentIds: [root.id], actionableCommentDatabaseIds: [root.databaseId] };
  const genuine = "09a9db735031d233";
  const derived = fingerprintFinding({ severity: "medium", summary: "derived member" });
  const act = new Set([genuine, ACT_FP, derived]);
  assert.deepEqual(selectActThreadBinding({ threads: [thread], comments: [root] }, thread.id, "mfittko", act), { root, members: [genuine] });

  // Synthetic merged/repeated/shared/resolved/reordered roots and replies.
  const merged = { ...root, body: `${root.body}\n${ACT_MARKER}\n${ACT_MARKER}\n${ACT_MARKER.replace(ACT_FP, derived)}` };
  const shared = { ...root, id: "shared", threadId: "shared" };
  const parsed = { threads: [thread, { id: "shared", isResolved: true }], comments: [shared,
    { ...merged, id: "a-reply", databaseId: "4269574736", body: "reply" },
    { ...merged, id: "invalid", databaseId: "not-numeric", body: "invalid ID" }, merged] };
  assert.deepEqual(parsed.threads.map(({ id }) => selectActThreadBinding(parsed, id, "mfittko", act).members), [[genuine, ACT_FP, derived], [genuine]]);
  assert.equal(selectActThreadBinding(parsed, thread.id, "mfittko", act).root, merged);
  // Direct comment lookup remains valid even when the ID is absent from the thread enumeration.
  assert.deepEqual(selectActThreadBinding({ ...parsed, threads: [] }, thread.id, "mfittko", act).members, [genuine, ACT_FP, derived]);
  for (const comments of [
    [{ ...root, author: { login: "foreign" } }],
    [{ ...root, body: "unrelated" }],
    [{ ...root, body: "unmarked root" }, { ...root, databaseId: "4269574736" }],
  ]) assert.deepEqual(selectActThreadBinding({ comments }, thread.id, "mfittko", act).members, []);
  const fallback = [{ ...root, databaseId: null }, { ...root, databaseId: "node-id", body: "later" }];
  assert.equal(selectActThreadBinding({ comments: fallback }, thread.id, "mfittko", act).root, fallback[0]);
  const numericOrder = [{ ...root, databaseId: "10" }, { ...root, databaseId: "9" }];
  assert.equal(selectActThreadBinding({ comments: numericOrder }, thread.id, "mfittko", act).root, numericOrder[1]);
  assert.deepEqual(selectActThreadBinding({ comments: [root] }, "missing", "mfittko", act), { root: undefined, members: [] });
  assert.deepEqual(selectActThreadBinding({ comments: [root] }, thread.id, "mfittko", new Set()), { root, members: [] });
});

for (const failure of [null, "query", "login"]) test(`empty ACT membership still authenticates its live snapshot (${failure})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const entries = [threadsCallEntry([], failure === "query" ? { exitCode: 1, stderr: "query refused" } : {}),
      failure === "login" ? { ...userEntry, exitCode: 1, stderr: "login refused" } : userEntry];
    const { deps, calls } = runtime(entries, repoRoot);
    const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
    if (failure) await assert.rejects(verify(), failure === "query" ? /query refused/ : /login refused/);
    else assert.equal((await verify()).complete, true);
    assert.equal(calls.length, failure === "query" ? 2 : 3);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(calls), false);
  });
});

async function completionFixture(repoRoot, kind = "resolved", settings = {}) {
  if (settings.legacy) return legacyCompletionFixture(repoRoot, kind, settings);
  repoRoot = await realpath(repoRoot);
  initGitFixture(repoRoot, { branch: "issue-1" });
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { env: gitEnvNoDirOverrides(), encoding: "utf8" }).trim();
  await writeFile(path.join(repoRoot, ".gitignore"), "tmp/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "ignore evidence");
  const baseline = git("rev-parse", "HEAD"), tmpRoot = path.join(repoRoot, "tmp");
  await mkdir(tmpRoot);
  const actList = [0, 1, 2].map((index) => ({ ...ACT_LIST[0], summary: index === 2 ? "second member" : "s", siteQuery: "query", acceptedForms: [`--${index}`] }));
  for (const item of actList) item.fingerprint = fingerprintFinding(item);
  const second = actList[2].fingerprint, residual = kind !== "resolved";
  const isResidual = (index) => residual && (kind === "residual" || index === (kind === "repeated-mixed" ? 1 : 2));
  const actPath = path.join(tmpRoot, "act.json"), deltaPath = path.join(tmpRoot, "delta.json"), logPath = path.join(tmpRoot, "findings.json");
  await writeFile(actPath, JSON.stringify(actList));
  const emit = (phase, extra = {}) => emitFixerWorkOrder({ repo: REPO, pr: PR, headSha: baseline, phase, actListFile: actPath, gate: "draft_gate", cwd: repoRoot,
    fetchPr: async () => ({ headRefName: "issue-1", headRefOid: baseline }), fetchVerdictMarkers: async () => ({ draft_gate: { visible: true, contractComplete: true } }), ...extra });
  const prior = await emit("commit_only");
  const pull = (plan) => pullWorkOrder({ ref: plan.workOrderRef, digest: plan.workOrderDigest, execution: plan.executionIdentity, cwd: repoRoot, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
  await pull(prior);
  git("commit", "-q", "--allow-empty", "-m", "fixing F");
  const fixing = git("rev-parse", "HEAD");
  const siteCoverage = [ACT_FP, second].map((fingerprint, index) => {
    const forms = index ? ["--2"] : ["--0", "--1"];
    const sites = forms.map((site) => ({ site, kind: "input_form", status: "fixed", reason: "", test: "  focused test reference  " }));
    if (forms.some((site) => isResidual(Number(site.slice(2))))) sites.push({ site: "unverified.mjs", kind: "site", status: "skipped", reason: "  still unverified at invocation three  " });
    return { fingerprint, returnedSites: sites.map(({ site }) => site), sites };
  });
  const originPath = prior.workOrder.outputRefs[0];
  await mkdir(path.dirname(originPath), { recursive: true });
  await writeFile(originPath, JSON.stringify({ headSha: fixing, siteCoverage }));
  await writeFile(logPath, JSON.stringify({ headSha: baseline, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const args = ["--act-list", actPath, "--baseline", baseline, "--worktree", repoRoot, "--fixer-plan", prior.planPath, "--site-coverage", originPath];
  const input = await runCli([...args, "--spec-identity", "spec@1", "--findings-log", logPath], { stdout: { write() {} } });
  if (residual) git("commit", "-q", "--allow-empty", "-m", "candidate B");
  const candidate = git("rev-parse", "HEAD"), items = input.input.actItems.map(({ ref }, index) => ({ ref, status: isResidual(index) ? "cannot_verify" : "resolved", evidence: ["focused check"] }));
  const delta = { ...input.input.resultShape, candidateHead: residual ? fixing : candidate, actionableItems: items, newFindings: [], widenedReads: [], outcome: residual ? "bounded_out" : "locally_clear" };
  await writeFile(deltaPath, JSON.stringify(delta));
  assert.equal((await runCli([...args, "--result", deltaPath, "--invocation", residual ? "3" : "1"], { stdout: { write() {} } })).nextStep, residual ? "push_to_gate" : "push");
  const threadBindings = kind === "threadless" ? [] : [{ threadId: "PRRT_MERGED", fingerprints: [ACT_FP, second] }, { threadId: "PRRT_SHARED", fingerprints: [ACT_FP] }];
  const dispositions = threadBindings.map(({ threadId, fingerprints }) => ({ threadId, fixingCommitSha: fixing,
    disposition: actList.some((item, index) => fingerprints.includes(item.fingerprint) && isResidual(index)) ? "deferred" : "tackled" }));
  const nodes = threadBindings.map(({ threadId, fingerprints }, index) => actThread(threadId, [gateComment(`c${index}`, index + 1,
    fingerprints.map((fp) => `<!-- dev-loops:finding ${fp} severity=medium angle=correctness round=1 -->`).join("\n") + `\nFixed in commit ${fixing}.`)], dispositions[index].disposition === "tackled"));
  const plan = await emit("full", { deltaResult: deltaPath, runChild: makeGhMock([threadsCallEntry(nodes), userEntry]).runChild });
  if (settings.complete) {
    plan.executionIdentity = `f${Date.now()}-2800abcd`;
    plan.workOrderRef = `fixer:${REPO}#${PR}:${candidate}:${plan.executionIdentity}`;
    plan.workOrder.outputRefs = [path.join(path.dirname(plan.planPath), plan.executionIdentity, "fixer-disposition.json")];
    plan.promptPath = path.join(path.dirname(plan.planPath), "work-orders", `${plan.executionIdentity}.md`);
    plan.workOrder.operation = "complete";
    plan.workOrder.mutationAuthority.allowedPaths = [];
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    const text = renderWorkOrder(plan.workOrder);
    plan.materializationHash = materializationHash(text);
    await writeFile(plan.promptPath, text);
    await writeFile(plan.planPath, JSON.stringify(plan));
    await writeExecutionIndex(tmpRoot, plan);
  }
  await pull(plan);
  const fixerPlan = plan.planPath, sourceRead = plan.workOrder.requiredReads.find((read) => read.kind === "completion-input"), sourcePath = sourceRead.path;
  const source = JSON.parse(await readFile(sourcePath));
  const depsFor = (extra = []) => runtime([compareEntry(baseline, "ahead", candidate), compareEntry(fixing, "ahead", candidate), liveHeadEntry(candidate), threadsCallEntry(nodes), userEntry, ...ciEntries(candidate), ...extra], repoRoot, { live: false });
  assert.equal((await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: candidate, fixerPlan, construct: true }, depsFor().deps)).constructed, true);
  // Negative tests may reseal a corruption only after a genuine baseline was constructed.
  const seal = async () => {
    const bytes = `${JSON.stringify(source, null, 2)}\n`;
    await writeFile(sourcePath, bytes);
    sourceRead.sha256 = sha256Hex(Buffer.from(bytes)).slice(7);
    sourceRead.bytes = Buffer.byteLength(bytes);
    Object.assign(plan.workOrder.authority, { completionInputDigest: sha256Hex(source).slice(7), completionInputBytesDigest: sourceRead.sha256 });
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    await writeFile(fixerPlan, JSON.stringify(plan));
    const receiptPath = pullReceiptPath(tmpRoot, plan.workOrderRef), receipt = JSON.parse(await readFile(receiptPath));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: plan.workOrderDigest }));
    await writeMarked(plan.workOrder.outputRefs[0], JSON.stringify({ headSha: candidate, dispositions, siteCoverage }));
  };
  return { fixerPlan, plan, source, sourceRead, sourcePath, originPath, baseline, fixing, candidate, nodes, dispositions, seal, depsFor };
}

for (const kind of ["resolved", "threadless", "mixed"]) test(`explicit complete ACT constructs then verifies without clobber (${kind})`, async () => {
  await withRepoRoot(async (root) => {
    const f = await completionFixture(root, kind, { complete: true });
    const output = f.plan.workOrder.outputRefs[0], before = await readFile(output);
    for (const check of [false, true]) {
      const extra = f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead", f.candidate)] : [];
      assertCompleteModuloResidual(await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, check }, f.depsFor(extra).deps), check);
      assert.deepEqual(await readFile(output), before);
    }
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: true }, f.depsFor().deps), /EEXIST/);
    assert.deepEqual(await readFile(output), before);
  });
});

for (const defect of ["missing", "partial", "paths", "duplicate", "opposite", "raw", "semantic"]) test(`explicit complete delivery independently refuses ${defect}`, async () => {
  await withRepoRoot(async (root) => {
    const f = await completionFixture(root, "resolved", { complete: true });
    // Deliberate negative resealing exercises verifier authority independently of pull admission.
    const order = f.plan.workOrder;
    if (defect === "missing") {
      order.requiredReads = order.requiredReads.filter((read) => read.kind !== "completion-input");
      delete order.authority.completionInputDigest;
      delete order.authority.completionInputBytesDigest;
    }
    if (defect === "partial") delete order.authority.completionInputBytesDigest;
    if (defect === "paths") order.mutationAuthority.allowedPaths = ["."];
    if (defect === "duplicate") order.requiredReads.push({ ...order.requiredReads[0] });
    if (defect === "opposite") order.requiredReads.push({ ...order.requiredReads[0], kind: "threads" });
    if (defect === "raw") order.authority.completionInputBytesDigest = "0".repeat(64);
    if (defect === "semantic") order.authority.completionInputDigest = "0".repeat(64);
    f.plan.workOrderDigest = workOrderDigest(order);
    await writeFile(f.fixerPlan, JSON.stringify(f.plan));
    const receiptPath = pullReceiptPath(path.join(root, "tmp"), f.plan.workOrderRef);
    const receipt = JSON.parse(await readFile(receiptPath));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: f.plan.workOrderDigest }));
    await writeFile(order.outputRefs[0], JSON.stringify({ headSha: f.candidate, dispositions: f.dispositions, siteCoverage: f.source.siteCoverage }));
    const mock = f.depsFor([compareEntry(f.fixing, "ahead", f.candidate)]);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan }, mock.deps));
    assert.deepEqual(await checkpointFiles(root), []);
    assert.equal(hasPost(mock.calls), false);
  });
});

// Explicit historical consumer fixtures retain their pre-producer identity format.
async function legacyCompletionFixture(repoRoot, kind = "resolved", settings = {}) {
  const { baseline = FIX_SHA, fixing = "d".repeat(40), candidate = HEAD_SHA } = settings;
  const second = "fedcba9876543210";
  const actList = settings.actList ?? [ACT_FP, ACT_FP, second].map((fingerprint, index) => ({ ...ACT_LIST[0], fingerprint, siteQuery: "query", acceptedForms: [`--${index}`] }));
  const sequence = startDeltaSequence({ reviewBaselineHead: baseline, actList });
  const residual = kind !== "resolved";
  const isResidual = (index) => residual && (kind === "residual" || index === (kind === "repeated-mixed" ? 1 : 2));
  const items = sequence.actItems.map(({ ref }, index) => ({ ref, status: isResidual(index) ? "cannot_verify" : "resolved", evidence: ["recorded result"] }));
  const siteCoverage = settings.siteCoverage ?? [ACT_FP, second].map((fingerprint, index) => ({
    fingerprint, returnedSites: index ? ["--2"] : ["--0", "--1"],
    sites: (index ? ["--2"] : ["--0", "--1"]).map((site) => ({ site, kind: "input_form", status: isResidual(Number(site.slice(2))) ? "skipped" : "fixed", ...(isResidual(Number(site.slice(2))) ? { reason: "  still unverified at invocation three  " } : { test: "  focused test reference  " }) })),
  }));
  const coverageDigest = sha256Hex(siteCoverage).slice(7);
  const delta = { reviewBaselineHead: baseline, candidateHead: residual ? "e".repeat(40) : candidate, actSetId: sequence.actSetId, actionableItems: items, newFindings: [], widenedReads: [], outcome: residual ? "bounded_out" : "locally_clear", siteCoverageDigest: coverageDigest };
  const decision = { ...delta, candidateHead: candidate, invocation: residual ? 3 : 1, nextStep: residual ? "push_to_gate" : "push", items };
  const threadBindings = settings.threadBindings ?? (kind === "threadless" ? [] : [{ threadId: "PRRT_MERGED", fingerprints: [ACT_FP, second] }, { threadId: "PRRT_SHARED", fingerprints: [ACT_FP] }]);
  const origin = { executionIdentity: "f0-1234abcd", workOrderRef: `fixer:${REPO}#${PR}:${baseline}:f0-1234abcd`, workOrderDigest: `sha256:${"1".repeat(64)}` };
  const source = { headSha: candidate, fixingCommitSha: fixing, siteCoverage, threadBindings, origin };
  const dispositions = threadBindings.map(({ threadId, fingerprints }) => ({ threadId, fixingCommitSha: fixing, disposition: actList.some((item, index) => fingerprints.includes(item.fingerprint) && isResidual(index)) ? "deferred" : "tackled" }));
  const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, orderHead: candidate, handoffText: JSON.stringify({ headSha: candidate, dispositions, siteCoverage }) });
  const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
  if (!settings.legacy) {
    plan.workOrder.source = "act-list";
    plan.workOrder.authority.reviewBaselineHead = baseline;
    for (const read of plan.workOrder.requiredReads) Object.assign(read, { required: true, bytes: (await readFile(read.path)).length });
  }
  plan.workOrderRef = `fixer:${REPO}#${PR}:${candidate}:${plan.executionIdentity}`;
  const sourcePath = path.join(path.dirname(fixerPlan), "completion.json");
  const originPath = path.join(path.dirname(fixerPlan), origin.executionIdentity, "fixer-disposition.json");
  await mkdir(path.dirname(originPath), { recursive: true });
  await writeFile(pullReceiptPath(path.join(repoRoot, "tmp"), origin.workOrderRef), JSON.stringify({ ...origin, role: "fixer", subject: { repo: REPO, pr: PR, branch: "issue-1", headSha: baseline, phase: "commit_only", planPath: fixerPlan } }));
  await writeFile(originPath, JSON.stringify({ headSha: fixing, dispositions: [], siteCoverage }));
  await writeFile(path.join(repoRoot, "tmp", "gate-delta", `${baseline}.json`), JSON.stringify(decision));
  const sourceRead = { kind: "completion-input", path: sourcePath, required: true, sha256: "" };
  plan.workOrder.requiredReads.push(sourceRead);
  const seal = async () => {
    const bytes = `${JSON.stringify(source, null, 2)}\n`;
    await writeFile(sourcePath, bytes);
    sourceRead.sha256 = createHash("sha256").update(bytes).digest("hex");
    Object.assign(plan.workOrder.authority, { completionInputDigest: sha256Hex(source).slice(7), completionInputBytesDigest: sourceRead.sha256 });
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    await writeFile(fixerPlan, JSON.stringify(plan));
    await writeFile(pullReceiptPath(path.join(repoRoot, "tmp"), plan.workOrderRef), JSON.stringify({ role: "fixer", workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity, subject: { repo: REPO, pr: PR, branch: "issue-1", headSha: candidate, phase: "full", planPath: fixerPlan } }));
    await writeMarked(plan.workOrder.outputRefs[0], JSON.stringify({ headSha: candidate, dispositions, siteCoverage }));
  };
  await seal();
  const nodes = threadBindings.map(({ threadId, fingerprints }, index) => actThread(threadId, [gateComment(`c${index}`, index + 1, fingerprints.map((fp) => `<!-- dev-loops:finding ${fp} severity=medium angle=correctness round=1 -->`).join("\n") + `\nFixed in commit ${fixing}.`)], dispositions[index].disposition === "tackled"));
  const depsFor = (extra = []) => runtime([compareEntry(baseline, "ahead", candidate), compareEntry(fixing, "ahead", candidate), liveHeadEntry(candidate), threadsCallEntry(nodes), userEntry, ...ciEntries(candidate), ...extra], repoRoot, { live: false });
  return { fixerPlan, plan, source, sourceRead, sourcePath, originPath, baseline, fixing, nodes, dispositions, seal, depsFor };
}

for (const mode of ["normal", "check", "construct"]) for (const defect of ["sourceDigest", "deltaResultDigest", "optional", "duplicate", "length", "baseline"]) test(`completion ${mode} refuses supplied review baseline ${defect} before optional authority branches`, async () => {
  await withRepoRoot(async (root) => {
    const f = await completionFixture(root);
    const order = f.plan.workOrder;
    if (["sourceDigest", "deltaResultDigest"].includes(defect)) delete order.authority[defect];
    if (defect === "optional") order.requiredReads[0].required = false;
    if (defect === "duplicate") order.requiredReads.push({ ...order.requiredReads[0] });
    if (defect === "length") order.requiredReads[0].bytes++;
    if (defect === "baseline") order.authority.reviewBaselineHead = "c".repeat(40);
    await f.seal();
    const { deps, calls } = f.depsFor();
    if (mode === "construct") await rm(order.outputRefs[0]);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, tmpRoot: "tmp", check: mode === "check", construct: mode === "construct" }, deps), /review baseline/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(path.join(root, "tmp/gate-findings")), false);
  });
});

const LEGACY_PATTERN = "readValidationEvidence|requireBinding|validationResultsPath|prefix-file";
const LEGACY_FILES = [
  "scripts/github/_validation-evidence.mjs",
  "scripts/github/verify-fresh-review-context.mjs",
  "scripts/github/upsert-checkpoint-verdict.mjs",
  "scripts/loop/emit-judge-work-order.mjs",
  "scripts/github/write-gate-context.mjs",
  "scripts/github/verify-briefing-prefixes.mjs",
  "skills/docs/gate-review-sub-loop-contract.md",
  ".claude/skills/docs/gate-review-sub-loop-contract.md",
  "skills/copilot-pr-followup/SKILL.md",
  ".claude/skills/copilot-pr-followup/SKILL.md",
  "CHANGELOG.md",
  "test/github/_validation-fixture.mjs",
  "test/github/reviewer-work-order.test.mjs",
  "test/github/upsert-checkpoint-verdict.test.mjs",
  "test/github/verify-briefing-prefixes.test.mjs",
  "test/github/verify-fresh-review-context.test.mjs",
  "test/github/write-gate-context.test.mjs",
  "test/github/validation-evidence.test.mjs",
];
const LEGACY_FORMS = [
  "Old prefix-file context with validationResultsPath, no validation requiredRead, valid current-head complete/failed/incomplete configured evidence",
  "Existing current-head statusless configured evidence with boolean allPassed and suites",
  "Valid current-head not_configured with full matching reference/hash/bytes and trusted absence provenance",
  "not_configured without full hash-bound validation requiredRead",
  "Supplied validation binding with wrong path/hash/bytes or duplicate validation reads",
  "Wrong-head, malformed, unsupported-status or unreadable validation evidence",
  "not_configured with missing or invalid trusted absence provenance",
];
async function legacyFixture(repoRoot) {
  initGitFixture(repoRoot, { branch: "issue-1" });
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined,
    GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "grep.column", GIT_CONFIG_VALUE_0: "false" }, encoding: "utf8" });
  const baseline = git("rev-parse", "HEAD").trim();
  for (const [index, file] of LEGACY_FILES.entries()) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), "readValidationEvidence\n".repeat(index < 11 ? 12 : 11));
  }
  git("add", ".");
  git("commit", "-qm", "209 legacy query rows across 18 files");
  const candidate = git("rev-parse", "HEAD").trim();
  const coverage = [{ fingerprint: ACT_FP, returnedSites: [...LEGACY_FILES], sites: [
    ...LEGACY_FORMS.map((site) => ({ site, kind: "input_form", status: "fixed", reason: "", test: "test/github/validation-evidence.test.mjs: historical input form" })),
    ...LEGACY_FILES.map((site, index) => ({ site, kind: "site", status: index ? "skipped" : "fixed", reason: index ? "shared reader; no direct edit" : "", ...index ? {} : { test: "historical reader regression" } })),
  ] }];
  const f = await completionFixture(repoRoot, "resolved", { legacy: true, baseline, candidate, fixing: candidate, siteCoverage: coverage,
    actList: [{ ...ACT_LIST[0], siteQuery: LEGACY_PATTERN, acceptedForms: LEGACY_FORMS.slice(0, 3), rejectedForms: LEGACY_FORMS.slice(3) }],
    threadBindings: [{ threadId: "PRRT_MERGED", fingerprints: [ACT_FP] }] });
  const order = f.plan.workOrder;
  Object.assign(order, { source: "act-list", gate: "draft_gate" });
  const decisionPath = path.join(repoRoot, "tmp", "gate-delta", `${baseline}.json`);
  for (const read of order.requiredReads.filter((read) => read.kind !== "completion-input")) {
    if (read.kind === "delta-result") {
      const delta = JSON.parse(await readFile(read.path));
      delete delta.siteCoverageDigest;
      await writeFile(read.path, JSON.stringify(delta));
      order.authority.deltaResultDigest = sha256Hex(delta).slice(7);
    }
    const bytes = await readFile(read.path);
    Object.assign(read, { required: true, bytes: bytes.length, sha256: sha256Hex(bytes).slice(7) });
  }
  const decision = JSON.parse(await readFile(decisionPath));
  delete decision.siteCoverageDigest;
  await writeFile(decisionPath, JSON.stringify(decision));
  const original = { executionIdentity: "f0-8765abcd", workOrderRef: `fixer:${REPO}#${PR}:${baseline}:f0-8765abcd` };
  const oldOrder = structuredClone(order);
  oldOrder.headSha = baseline;
  oldOrder.requiredReads = oldOrder.requiredReads.filter((read) => read.kind !== "completion-input");
  delete oldOrder.authority.completionInputDigest;
  delete oldOrder.authority.completionInputBytesDigest;
  original.workOrderDigest = workOrderDigest(oldOrder);
  const prompt = `Historical producer prose, intentionally never rerendered.\n\n## Work order\n\n\`\`\`json\n${JSON.stringify(oldOrder, null, 2)}\n\`\`\`\n`;
  const oldPlan = { ...original, workOrder: oldOrder, materializationHash: sha256Hex(prompt) };
  const archivePath = path.join(path.dirname(f.fixerPlan), original.executionIdentity, "original-fixer-emit-plan.json");
  const promptPath = path.join(path.dirname(f.fixerPlan), "work-orders", `${original.executionIdentity}.md`);
  await mkdir(path.dirname(archivePath), { recursive: true });
  await mkdir(path.dirname(promptPath), { recursive: true });
  await writeFile(archivePath, JSON.stringify(oldPlan));
  await writeFile(promptPath, prompt);
  const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), original.workOrderRef);
  await writeFile(receiptPath, JSON.stringify({ ...original, role: "fixer", materializationHash: oldPlan.materializationHash,
    subject: { repo: REPO, pr: PR, headSha: baseline, branch: "issue-1", phase: "full", planPath: f.fixerPlan } }));
  const query = git("--no-pager", "-c", "color.ui=never", "grep", "-n", "-E", LEGACY_PATTERN, candidate, "--");
  assert.equal(query.trimEnd().split("\n").length, 209);
  f.source.legacyRevalidation = { origin: "legacy_revalidated", originalFull: { ...original, planBytesDigest: sha256Hex(await readFile(archivePath)).slice(7) },
    handbackBytesDigest: sha256Hex(await readFile(f.originPath)).slice(7), clearingDecisionBytesDigest: sha256Hex(await readFile(decisionPath)).slice(7),
    treeOid: git("rev-parse", `${candidate}^{tree}`).trim(), queryOutputBytesDigest: sha256Hex(query).slice(7) };
  await f.seal();
  const refreshOriginal = async () => {
    oldPlan.workOrderDigest = workOrderDigest(oldPlan.workOrder);
    const text = `Historical producer prose.\n\n## Work order\n\n\`\`\`json\n${JSON.stringify(oldPlan.workOrder, null, 2)}\n\`\`\`\n`;
    oldPlan.materializationHash = sha256Hex(text);
    await writeFile(promptPath, text);
    await writeFile(archivePath, JSON.stringify(oldPlan));
    Object.assign(f.source.legacyRevalidation.originalFull, { workOrderDigest: oldPlan.workOrderDigest, planBytesDigest: sha256Hex(await readFile(archivePath)).slice(7) });
    const receipt = JSON.parse(await readFile(receiptPath));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: oldPlan.workOrderDigest, materializationHash: oldPlan.materializationHash }));
  };
  return { ...f, candidate, oldPlan, archivePath, promptPath, receiptPath, decisionPath, git, refreshOriginal };
}

test("prospective legacy preparation authenticates while original full stays active and consumer refuses inactive preview", async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root);
    const originalFullBytes = await readFile(f.archivePath);
    await writeFile(f.fixerPlan, originalFullBytes);
    const files = [f.fixerPlan, f.archivePath, f.promptPath, f.receiptPath, f.originPath, f.decisionPath,
      ...f.oldPlan.workOrder.requiredReads.map((read) => read.path)];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const [actList, delta] = await Promise.all(f.plan.workOrder.requiredReads.slice(0, 2).map(async (read) => JSON.parse(await readFile(read.path))));
    const args = { completion: f.source, prospectivePlan: f.plan, planPath: f.fixerPlan, originalFullBytes,
      priorBytes: await readFile(f.originPath), actList, delta, decision: JSON.parse(await readFile(f.decisionPath)), receiptTmpRoot: path.join(root, "tmp"), repoRoot: root };
    assert.equal(typeof legacyOwner.prepareLegacyCompletion, "function");
    assert.deepEqual(await legacyOwner.prepareLegacyCompletion(args), f.source.legacyRevalidation);
    await assert.rejects(legacyOwner.revalidateLegacyCompletion({ ...args, plan: f.plan }), /superseded/);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
  });
});

test("prospective legacy preparation rejects invalid canonical clearing decision invocations", async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root), originalFullBytes = await readFile(f.archivePath);
    await writeFile(f.fixerPlan, originalFullBytes);
    const [actList, delta] = await Promise.all(f.plan.workOrder.requiredReads.slice(0, 2).map(async (read) => JSON.parse(await readFile(read.path))));
    const decision = JSON.parse(await readFile(f.decisionPath)), priorBytes = await readFile(f.originPath);
    for (const invocation of [undefined, "1", 0, 4, 1.5]) {
      if (invocation === undefined) delete decision.invocation;
      else decision.invocation = invocation;
      await writeFile(f.decisionPath, JSON.stringify(decision));
      await assert.rejects(legacyOwner.prepareLegacyCompletion({ completion: f.source, prospectivePlan: f.plan, planPath: f.fixerPlan,
        originalFullBytes, priorBytes, actList, delta, decision, receiptTmpRoot: path.join(root, "tmp"), repoRoot: root }), /legacy requires fresh locally clear/);
      assert.deepEqual(await readFile(f.fixerPlan), originalFullBytes);
    }
  });
});

for (const defect of ["before", "originSubject", "originBytes", "originPrePull", "originSymlink", "archiveBytes", "prospectiveDigest", "partialModern"]) {
  test(`prospective legacy preparation refuses ${defect}`, async () => {
    await withRepoRoot(async (root) => {
      const f = await legacyFixture(root), originalFullBytes = await readFile(f.archivePath);
      await writeFile(f.fixerPlan, defect === "before" ? Buffer.concat([originalFullBytes, Buffer.from("\n")]) : originalFullBytes);
      const [actList, delta] = await Promise.all(f.plan.workOrder.requiredReads.slice(0, 2).map(async (read) => JSON.parse(await readFile(read.path))));
      const priorBytes = await readFile(f.originPath);
      if (defect === "originSubject") {
        const file = pullReceiptPath(path.join(root, "tmp"), f.source.origin.workOrderRef), receipt = JSON.parse(await readFile(file));
        receipt.subject.phase = "full";
        await writeFile(file, JSON.stringify(receipt));
        await utimes(file, 1, 1);
      }
      if (defect === "originBytes") await writeFile(f.originPath, `${priorBytes}\n`);
      if (defect === "originPrePull") await utimes(f.originPath, 0, 0);
      if (defect === "originSymlink") { await rm(f.originPath); await symlink(f.sourcePath, f.originPath); }
      if (defect === "archiveBytes") await writeFile(f.archivePath, Buffer.concat([originalFullBytes, Buffer.from("\n")]));
      if (defect === "prospectiveDigest") f.plan.workOrderDigest = `sha256:${"0".repeat(64)}`;
      if (defect === "partialModern") delta.siteCoverageDigest = "0".repeat(64);
      await assert.rejects(legacyOwner.prepareLegacyCompletion({ completion: f.source, prospectivePlan: f.plan, planPath: f.fixerPlan,
        originalFullBytes, priorBytes, actList, delta, decision: JSON.parse(await readFile(f.decisionPath)), receiptTmpRoot: path.join(root, "tmp"), repoRoot: root }));
      assert.deepEqual(await readFile(f.fixerPlan), defect === "before" ? Buffer.concat([originalFullBytes, Buffer.from("\n")]) : originalFullBytes);
    });
  });
}

test("explicit legacy completion requalifies unchanged evidence with inherited grep.column=true in construct, normal and check", async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root);
    const preserved = [f.archivePath, f.promptPath, f.receiptPath, f.originPath, f.decisionPath];
    const before = await Promise.all(preserved.map((file) => readFile(file, "utf8")));
    f.git("config", "grep.column", "true");
    const options = { repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan };
    await rm(f.plan.workOrder.outputRefs[0]);
    await rm(`${f.plan.workOrder.outputRefs[0]}.constructed`);
    assert.equal((await verifyFixerDisposition({ ...options, construct: true }, f.depsFor().deps)).constructed, true);
    for (const check of [false, true]) {
      const mock = f.depsFor([compareEntry(f.candidate, "identical", f.candidate)]);
      assert.equal((await verifyFixerDisposition({ ...options, check }, mock.deps)).complete, true);
      assert.equal(hasPost(mock.calls), false);
    }
    assert.deepEqual(JSON.parse(await readFile(f.plan.workOrder.outputRefs[0])).siteCoverage, f.source.siteCoverage);
    assert.deepEqual(await Promise.all(preserved.map((file) => readFile(file, "utf8"))), before);
  });
});

test("legacy archived local Delta fields remain bound when semantic work-order identity excludes them", async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root);
    const deltaRead = f.oldPlan.workOrder.requiredReads.find((read) => read.kind === "delta-result");
    Object.assign(deltaRead, { path: path.join(root, "substituted.json"), sha256: "0".repeat(64), bytes: 1 });
    assert.equal(workOrderDigest(f.oldPlan.workOrder), f.oldPlan.workOrderDigest);
    await writeFile(f.archivePath, JSON.stringify(f.oldPlan));
    f.source.legacyRevalidation.originalFull.planBytesDigest = sha256Hex(await readFile(f.archivePath)).slice(7);
    await f.seal();
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, check: true }, f.depsFor().deps), /historical.*suffix/i);
    assert.deepEqual(await checkpointFiles(root), []);
  });
});

for (const failure of ["plan", "preparePlan", "discovery", "empty", "relative"]) test(`legacy qualification refuses ${failure} failure without completing its native query`, async () => {
  await withRepoRoot(async (lexicalRoot) => {
    const root = await realpath(lexicalRoot);
    const f = await legacyFixture(root);
    const originalFullBytes = await readFile(f.archivePath);
    if (failure === "preparePlan") await writeFile(f.fixerPlan, originalFullBytes);
    const source = await readFile(new URL("../../scripts/github/_legacy-fixer-revalidation.mjs", import.meta.url), "utf8");
    let injections = 0;
    let queries = 0;
    const canonicalPlan = await realpath(f.fixerPlan);
    const context = Object.assign({ Buffer, JSON, path, sha256Hex, realpath, lstat,
      readFile: async (file, ...args) => {
        const bytes = await readFile(file, ...args);
        if (await realpath(file) === canonicalPlan && queries > 0) {
          injections++;
          return Buffer.concat([bytes, Buffer.from("\n")]);
        }
        return bytes;
      },
      spawnSync: (...args) => {
        const result = spawnSync(...args);
        if (args[1].includes("grep")) {
          assert.equal(result.status, 0, "supersession follows a successful native query");
          queries++;
        }
        return result;
      },
    }, await import("@dev-loops/core/loop/gate-round-retirement"), await import("@dev-loops/core/loop/fixer-disposition"),
    await import("@dev-loops/core/loop/pre-push-delta-review"), await import("../../scripts/loop/_repo-root-resolver.mjs"),
    await import("../../scripts/loop/_gate-delta-record.mjs"), await import("../../scripts/github/_gate-artifact-paths.mjs"), await import("../../scripts/github/_work-order-protocol.mjs"),
    await import("../../scripts/github/_fixer-emission-evidence.mjs"));
    if (failure === "discovery") context.listWorktreeEntries = () => { throw Object.assign(new Error("worktree listing failed"), { code: "ETIMEDOUT" }); };
    if (failure === "empty" || failure === "relative") context.listWorktreeEntries = () => failure === "empty" ? [] : [{ path: "relative" }];
    const qualify = runInNewContext(`${source.slice(source.indexOf("const PATTERN")).replaceAll("export async function", "async function")}\n${failure === "preparePlan" ? "prepareLegacyCompletion" : "revalidateLegacyCompletion"}`, context);
    const [act, delta] = await Promise.all(f.plan.workOrder.requiredReads.slice(0, 2).map(async (read) => JSON.parse(await readFile(read.path))));
    const planPath = failure === "plan" ? path.join(lexicalRoot, path.relative(root, f.fixerPlan)) : f.fixerPlan;
    await assert.rejects(qualify({ completion: f.source, plan: f.plan, prospectivePlan: f.plan, originalFullBytes, planPath, priorBytes: await readFile(f.originPath), actList: act, delta,
      decision: JSON.parse(await readFile(f.decisionPath)), receiptTmpRoot: path.join(root, "tmp"), repoRoot: root }), ["plan", "preparePlan"].includes(failure) ? /superseded during query/ : failure === "discovery" ? { code: "ETIMEDOUT", message: "worktree listing failed" } : /retirement checkout discovery returned no valid absolute roots/);
    assert.equal(queries, ["plan", "preparePlan"].includes(failure) ? 1 : 0);
    assert.equal(injections, ["plan", "preparePlan"].includes(failure) ? 1 : 0);
  });
});

for (const mode of ["construct", "normal", "check"]) for (const retiredIdentity of [null, "historical", "current", "lookupFailure"]) test(`legacy ${mode} checks linked-worktree retirement for ${retiredIdentity ?? "ordinary absence"}`, async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root);
    const linked = path.join(root, "linked");
    f.git("worktree", "add", "--detach", linked, f.candidate);
    assert.ok(f.receiptPath.startsWith(path.join(root, "tmp")), "receipts stay in the main checkout");
    if (retiredIdentity) {
      const head = retiredIdentity === "historical" ? f.baseline : f.candidate;
      const retired = path.join(linked, "tmp", "retired-gate-rounds", head, "round1", "retirement.json");
      if (retiredIdentity === "lookupFailure") {
        await mkdir(path.dirname(path.dirname(path.dirname(retired))), { recursive: true });
        await writeFile(path.dirname(path.dirname(retired)), "not a directory");
      } else {
        await mkdir(path.dirname(retired), { recursive: true });
        await writeFile(retired, JSON.stringify({ gate: "draft_gate", retiredAt: new Date().toISOString() }));
      }
    }
    const options = { repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: mode === "construct", check: mode === "check" };
    const report = f.plan.workOrder.outputRefs[0];
    if (mode === "construct") { await rm(report); await rm(`${report}.constructed`); }
    const before = existsSync(report) ? await readFile(report, "utf8") : null;
    const mock = f.depsFor([compareEntry(f.candidate, "identical", f.candidate)]);
    if (retiredIdentity) {
      await assert.rejects(verifyFixerDisposition(options, mock.deps), retiredIdentity === "lookupFailure" ? { code: "ENOTDIR" } : /legacy revalidation: source round was retired/);
      assert.equal(existsSync(report) ? await readFile(report, "utf8") : null, before);
      assert.deepEqual(await checkpointFiles(root), []);
    } else {
      const result = await verifyFixerDisposition(options, mock.deps);
      assert.equal(mode === "construct" ? result.constructed : result.complete, true);
    }
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const mode of ["construct", "normal", "check"]) for (const defect of [
  "absent", "null", "partial", "originTriple", "archiveBytes", "suffix", "promptHash", "receiptMissing", "receiptRole", "receiptExecution", "receiptPath", "receiptBranch", "receiptPhase", "receiptHash",
  "oldRole", "oldSource", "oldBaseline", "oldBranch", "oldTarget", "oldExecution", "oldDuplicateRead", "oldReadRequired", "oldReadBytes", "oldReadHash", "oldAuthority", "currentReadRequired", "currentReadBytes", "currentDuplicateRead",
  "deltaHash", "decisionHash", "deltaProtocol", "decisionProtocol", "deltaOrigin", "decisionHandback", "decisionBytes", "handbackBytes", "rawKind", "rawEmptyReason", "rawTest", "rawNormalized",
  "missingFile", "extraFile", "duplicateFile", "missingForm", "extraForm", "duplicateForm", "formTest", "skipReason", "override", "fixing", "members", "foreignRoot", "replyOnly", "unsupportedQuery", "shellQuery", "invalidERE", "retired", "retirementNotDirectory", "branch", "tree", "queryDigest", "candidate", "status", "bounded",
].filter((defect) => mode !== "construct" || defect !== "override")) test(`legacy authentication refuses ${defect} before side effects (${mode})`, async () => {
  await withRepoRoot(async (root) => {
    const f = await legacyFixture(root);
    const legacy = f.source.legacyRevalidation;
    const raw = f.source.siteCoverage[0];
    const oldRead = f.oldPlan.workOrder.requiredReads[1];
    if (defect === "absent") delete f.source.legacyRevalidation;
    if (defect === "null") f.source.legacyRevalidation = null;
    if (defect === "partial") delete legacy.originalFull;
    if (defect === "originTriple") f.source.origin.extra = true;
    if (defect === "archiveBytes") legacy.originalFull.planBytesDigest = "0".repeat(64);
    if (defect === "suffix") f.oldPlan.workOrder.requiredReads[1].path = path.join(root, "substitute.json");
    if (defect === "promptHash") await writeFile(f.promptPath, "altered original prose\n");
    if (defect.startsWith("receipt")) {
      const receipt = JSON.parse(await readFile(f.receiptPath));
      if (defect === "receiptRole") receipt.role = "judge";
      if (defect === "receiptExecution") receipt.executionIdentity = f.plan.executionIdentity;
      if (defect === "receiptPath") receipt.subject.planPath = f.archivePath;
      if (defect === "receiptBranch") receipt.subject.branch = "main";
      if (defect === "receiptPhase") receipt.subject.phase = "commit_only";
      if (defect === "receiptHash") receipt.materializationHash = `sha256:${"0".repeat(64)}`;
      await writeFile(f.receiptPath, JSON.stringify(receipt));
      if (defect === "receiptMissing") await rm(f.receiptPath);
    }
    if (defect === "oldRole") f.oldPlan.workOrder.role = "judge";
    if (defect === "oldSource") f.oldPlan.workOrder.source = "threads";
    if (defect === "oldBaseline") f.oldPlan.workOrder.headSha = f.candidate;
    if (defect === "oldBranch") f.oldPlan.workOrder.mutationAuthority.branch = "main";
    if (defect === "oldTarget") f.oldPlan.workOrder.target.pr++;
    if (defect === "oldExecution") legacy.originalFull.executionIdentity = f.plan.executionIdentity;
    if (defect === "oldDuplicateRead") f.oldPlan.workOrder.requiredReads.push({ ...oldRead });
    if (defect === "oldReadRequired") oldRead.required = false;
    if (defect === "oldReadBytes") oldRead.bytes++;
    if (defect === "oldReadHash") oldRead.sha256 = "0".repeat(64);
    if (defect === "oldAuthority") f.oldPlan.workOrder.authority.deltaResultDigest = "0".repeat(64);
    if (defect.startsWith("old") || defect === "suffix") {
      await writeFile(f.archivePath, JSON.stringify(f.oldPlan));
      legacy.originalFull.planBytesDigest = sha256Hex(await readFile(f.archivePath)).slice(7);
    }
    if (["oldDuplicateRead", "oldReadRequired", "oldReadBytes", "oldReadHash", "oldAuthority"].includes(defect)) await f.refreshOriginal();
    if (defect === "currentReadRequired") f.plan.workOrder.requiredReads[1].required = false;
    if (defect === "currentReadBytes") f.plan.workOrder.requiredReads[1].bytes++;
    if (defect === "currentDuplicateRead") f.plan.workOrder.requiredReads.push({ ...f.plan.workOrder.requiredReads[1] });
    const deltaPath = f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").path;
    const delta = JSON.parse(await readFile(deltaPath));
    const decision = JSON.parse(await readFile(f.decisionPath));
    if (defect === "deltaHash") delta.siteCoverageDigest = null;
    if (defect === "decisionHash") decision.siteCoverageDigest = sha256Hex(f.source.siteCoverage).slice(7);
    if (defect === "deltaProtocol") delta.coverageProtocol = null;
    if (defect === "decisionProtocol") decision.coverageProtocol = "pulled_commit_only_v1";
    if (defect === "deltaOrigin") delta.origin = f.source.origin;
    if (defect === "decisionHandback") decision.handbackBytesDigest = legacy.handbackBytesDigest;
    if (defect === "candidate") decision.candidateHead = f.baseline;
    if (defect === "status") decision.items[0].status = "cannot_verify";
    if (defect === "bounded") Object.assign(decision, { outcome: "bounded_out", nextStep: "push_to_gate", invocation: 3 });
    await writeFile(deltaPath, JSON.stringify(delta));
    const deltaRead = f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result");
    deltaRead.sha256 = sha256Hex(await readFile(deltaPath)).slice(7);
    f.plan.workOrder.authority.deltaResultDigest = sha256Hex(delta).slice(7);
    await writeFile(f.decisionPath, JSON.stringify(decision) + (defect === "decisionBytes" ? "\n" : ""));
    if (defect === "handbackBytes") legacy.handbackBytesDigest = "0".repeat(64);
    if (defect === "rawKind") raw.sites[7].kind = "input_form";
    if (defect === "rawEmptyReason") delete raw.sites[0].reason;
    if (defect === "rawTest") raw.sites[0].test += " changed";
    if (defect === "rawNormalized") f.source.siteCoverage = (await import("@dev-loops/core/loop/fixer-disposition")).normalizeFixerDispositionHandoff(JSON.parse(await readFile(f.originPath))).siteCoverage;
    if (defect === "missingFile") raw.returnedSites.pop();
    if (defect === "extraFile") raw.returnedSites.push("extra.mjs");
    if (defect === "duplicateFile") raw.returnedSites.push(raw.returnedSites[0]);
    if (defect === "missingForm") raw.sites.shift();
    if (defect === "extraForm") raw.sites.push({ site: "extra", kind: "input_form", status: "fixed", test: "test" });
    if (defect === "duplicateForm") raw.sites.push(raw.sites[0]);
    if (defect === "formTest") raw.sites[0].test = "";
    if (defect === "skipReason") raw.sites[8].reason = "";
    if (["missingFile", "extraFile", "duplicateFile", "missingForm", "extraForm", "duplicateForm", "formTest", "skipReason"].includes(defect)) {
      await writeFile(f.originPath, JSON.stringify({ headSha: f.candidate, dispositions: [], siteCoverage: f.source.siteCoverage }));
      legacy.handbackBytesDigest = sha256Hex(await readFile(f.originPath)).slice(7);
    }
    if (defect === "override") Object.assign(f.dispositions[0], { fingerprint: ACT_FP, returnedSites: ["override"], sites: [{ site: "override", status: "fixed" }] });
    if (defect === "fixing") f.source.fixingCommitSha = f.baseline;
    if (defect === "members") f.source.threadBindings[0].fingerprints.push("fedcba9876543210");
    if (defect === "foreignRoot") f.nodes[0].comments.nodes[0].author.login = "someone-else";
    if (defect === "replyOnly") f.nodes[0].comments.nodes.unshift(gateComment("original", 0, "unmarked root"));
    if (["unsupportedQuery", "shellQuery", "invalidERE"].includes(defect)) {
      const actRead = f.plan.workOrder.requiredReads[0];
      const act = JSON.parse(await readFile(actRead.path));
      act[0].siteQuery = defect === "invalidERE" ? "[" : defect === "shellQuery" ? `${LEGACY_PATTERN}; echo forged` : "other";
      await writeFile(actRead.path, JSON.stringify(act));
      actRead.sha256 = sha256Hex(await readFile(actRead.path)).slice(7);
      f.plan.workOrder.authority.sourceDigest = sha256Hex(act).slice(7);
      Object.assign(f.oldPlan.workOrder.requiredReads[0], { sha256: actRead.sha256, bytes: (await readFile(actRead.path)).length });
      f.oldPlan.workOrder.authority.sourceDigest = f.plan.workOrder.authority.sourceDigest;
      actRead.bytes = f.oldPlan.workOrder.requiredReads[0].bytes;
      delta.actSetId = startDeltaSequence({ reviewBaselineHead: f.baseline, actList: act }).actSetId;
      decision.actSetId = delta.actSetId;
      await writeFile(deltaPath, JSON.stringify(delta));
      await writeFile(f.decisionPath, JSON.stringify(decision));
      Object.assign(deltaRead, { sha256: sha256Hex(await readFile(deltaPath)).slice(7), bytes: (await readFile(deltaPath)).length });
      Object.assign(f.oldPlan.workOrder.requiredReads[1], deltaRead);
      f.plan.workOrder.authority.deltaResultDigest = sha256Hex(delta).slice(7);
      f.oldPlan.workOrder.authority.deltaResultDigest = f.plan.workOrder.authority.deltaResultDigest;
      legacy.clearingDecisionBytesDigest = sha256Hex(await readFile(f.decisionPath)).slice(7);
      await f.refreshOriginal();
    }
    if (defect === "retired") {
      const retired = path.join(root, "tmp", "retired-gate-rounds", f.baseline, "round1", "retirement.json");
      await mkdir(path.dirname(retired), { recursive: true });
      await writeFile(retired, JSON.stringify({ gate: "draft_gate", retiredAt: new Date().toISOString() }));
    }
    if (defect === "retirementNotDirectory") {
      const retired = path.join(root, "tmp", "retired-gate-rounds", f.baseline);
      await mkdir(path.dirname(retired), { recursive: true });
      await writeFile(retired, "not a directory");
    }
    if (defect === "branch") f.git("update-ref", "refs/heads/issue-1", f.baseline);
    if (defect === "tree") legacy.treeOid = "0".repeat(40);
    if (defect === "queryDigest") legacy.queryOutputBytesDigest = "0".repeat(64);
    await f.seal();
    if (mode === "construct") await rm(f.plan.workOrder.outputRefs[0]);
    const mock = f.depsFor([compareEntry(f.candidate, "identical", f.candidate)]);
    const before = existsSync(f.plan.workOrder.outputRefs[0]) ? await readFile(f.plan.workOrder.outputRefs[0], "utf8") : null;
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: mode === "construct", check: mode === "check" }, mock.deps),
      defect === "retirementNotDirectory" ? { code: "ENOTDIR" } : ["unsupportedQuery", "shellQuery", "invalidERE"].includes(defect) ? /unsupported legacy query scope or literal/ : undefined);
    assert.deepEqual(await checkpointFiles(root), []);
    assert.equal(hasPost(mock.calls), false);
    assert.equal(existsSync(f.plan.workOrder.outputRefs[0]) ? await readFile(f.plan.workOrder.outputRefs[0], "utf8") : null, before);
  });
});

test("new bound completion matches authenticated origin and exact report bytes in result AND decision", async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    assert.equal(existsSync(path.join(repoRoot, ".git")), true, "modern acceptance starts from a genuine committed producer chain");
    const deltaRead = f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result");
    const delta = JSON.parse(await readFile(deltaRead.path, "utf8"));
    const binding = { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: delta.siteCoverageDigest,
      handbackBytesDigest: sha256Hex(await readFile(f.originPath)).slice(7), origin: f.source.origin };
    const decisionPath = path.join(repoRoot, "tmp", "gate-delta", `${f.baseline}.json`);
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    const bind = async (resultBinding, decisionBinding) => {
      const value = { ...delta, ...resultBinding }, bytes = JSON.stringify(value);
      await writeFile(deltaRead.path, bytes);
      deltaRead.sha256 = sha256Hex(Buffer.from(bytes)).slice(7);
      deltaRead.bytes = Buffer.byteLength(bytes);
      f.plan.workOrder.authority.deltaResultDigest = sha256Hex(value).slice(7);
      await writeFile(decisionPath, JSON.stringify({ ...decision, ...decisionBinding }));
      await f.seal();
    };
    const options = { repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, check: true };
    await bind(binding, binding);
    const valid = await verifyFixerDisposition(options, f.depsFor([compareEntry(f.fixing, "identical", f.candidate)]).deps);
    assert.deepEqual(valid.incomplete, []);
    for (const surface of ["result", "decision"]) for (const field of ["origin", "handbackBytesDigest"]) {
      const bad = { ...binding, [field]: field === "origin" ? { ...binding.origin, workOrderDigest: `sha256:${"2".repeat(64)}` } : "0".repeat(64) };
      await bind(surface === "result" ? bad : binding, surface === "decision" ? bad : binding);
      await assert.rejects(verifyFixerDisposition(options, f.depsFor().deps), /coverage binding|completion origin/);
    }
  });
});

test("typed completion CLI rejects construct/check together", () => {
  const args = ["--repo", REPO, "--pr", String(PR), "--head-sha", HEAD_SHA, "--fixer-plan", "plan", "--construct"];
  assert.equal(parseVerifyFixerDispositionCliArgs(args).construct, true);
  assert.throws(() => parseVerifyFixerDispositionCliArgs([...args, "--check"]), /mutually exclusive/);
});

test("typed completion path guard accepts canonical Windows paths with helper-normalized separators", async () => {
  const source = await readFile(new URL("../../scripts/github/verify-fixer-disposition.mjs", import.meta.url), "utf8");
  const start = source.indexOf("    const executionDir = path.join(await realpath(path.dirname(planPath)), plan.executionIdentity);");
  const end = source.indexOf("\n  }\n  if (optionalCompletion)", start);
  assert.ok(start >= 0 && end > start);
  const planPath = "C:\\repo\\tmp\\gate-fixer\\owner-repo\\pr-1975\\fixer-emit-plan.json";
  const executionIdentity = "f1-0000abcd";
  const normalized = [];
  // Exercise the production guard with Windows path semantics and the helper's forward-slash contract.
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    path: path.win32, planPath, plan: { executionIdentity },
    handoffPath: path.win32.join(path.win32.dirname(planPath), executionIdentity, "fixer-disposition.json"),
    realpath: async (file) => file,
    lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    realpathNearestExisting: (file) => { normalized.push(file); return path.win32.normalize(file).replaceAll("\\", "/"); },
  });
  assert.deepEqual(normalized, [path.win32.join(path.win32.dirname(planPath), executionIdentity), path.win32.join(path.win32.dirname(planPath), executionIdentity, "fixer-disposition.json")]);
  for (const code of ["EACCES", "ENOTDIR", "EIO"]) {
    await assert.rejects(runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
      path, planPath: "/repo/plan.json", plan: { executionIdentity }, handoffPath: `/repo/${executionIdentity}/fixer-disposition.json`,
      realpath: async (file) => file,
      lstat: async () => { throw Object.assign(new Error("uncertain output location"), { code }); },
      realpathNearestExisting: () => assert.fail("uncertain locations must not fall back to lexical paths"),
    }), (error) => error.code === code);
  }
});

for (const existing of ["output", "origin", "source", "late-origin"]) test(`typed completion refuses existing ${existing} without clobbering evidence`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    const output = f.plan.workOrder.outputRefs[0];
    if (existing !== "output") await rm(output);
    const createLink = () => link(existing === "source" ? f.sourcePath : f.originPath, output);
    if (existing === "origin" || existing === "source") {
      await createLink();
      const now = new Date(Date.now() + 1000);
      await utimes(output, now, now);
    }
    const files = [f.originPath, f.sourcePath, ...(existing === "late-origin" ? [] : [output])];
    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const mock = f.depsFor();
    const deps = { ...mock.deps, runChild: async (...args) => {
      if (existing === "late-origin" && args[1][0] === "pr") await createLink();
      return mock.deps.runChild(...args);
    } };
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: true }, deps), /EEXIST/);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before);
    if (existing === "late-origin") assert.equal(await readFile(output, "utf8"), before[0]);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const check of [false, true]) for (const defect of ["partial", "coverage", "dispositionCoverage", "fixing", "membership", "bytes", "origin", "delta"]) test(`typed completion normal/check retains optional authentication (${check}, ${defect})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    if (defect === "partial") {
      delete f.plan.workOrder.authority.completionInputBytesDigest;
      f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder);
      await writeFile(f.fixerPlan, JSON.stringify(f.plan));
      const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), f.plan.workOrderRef);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      receipt.workOrderDigest = f.plan.workOrderDigest;
      await writeFile(receiptPath, JSON.stringify(receipt));
    }
    if (defect === "membership") { f.source.threadBindings[0].fingerprints.pop(); await f.seal(); }
    const output = f.plan.workOrder.outputRefs[0];
    const raw = JSON.parse(await readFile(output, "utf8"));
    if (defect === "coverage") raw.siteCoverage[0].sites[0].test = "invented test";
    if (defect === "dispositionCoverage") Object.assign(raw.dispositions[0], {
      ...structuredClone(raw.siteCoverage[0]),
      sites: raw.siteCoverage[0].sites.map((site) => ({ ...site, test: "invented test" })),
    });
    if (defect === "fixing") raw.dispositions[0].fixingCommitSha = FIX_SHA;
    await writeMarked(output, JSON.stringify(raw));
    if (defect === "bytes") await writeFile(f.sourcePath, `${await readFile(f.sourcePath, "utf8")} `);
    if (defect === "origin") await rm(f.originPath);
    if (defect === "delta") await rm(path.join(repoRoot, "tmp", "gate-delta", `${f.baseline}.json`));
    const before = [await readFile(output, "utf8"), (await stat(output)).mtimeMs];
    const mock = f.depsFor();
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, check }, mock.deps),
      defect === "dispositionCoverage" ? /disposition-level coverage cannot override authenticated completion input/ : undefined);
    assert.deepEqual([await readFile(output, "utf8"), (await stat(output)).mtimeMs], before);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const check of [false, true]) test(`typed completion accepts scalar fingerprint hints without coverage overrides (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    const output = f.plan.workOrder.outputRefs[0];
    const raw = JSON.parse(await readFile(output, "utf8"));
    raw.dispositions[1].fingerprint = ACT_FP;
    await writeMarked(output, JSON.stringify(raw));
    const mock = f.depsFor([compareEntry(f.fixing, "identical", f.candidate)]);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, check }, mock.deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const check of [false, true]) test(`legacy ACT retains disposition-level coverage without optional completion authority (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
    const dispositions = [{ threadId: "PRRT_LEGACY", fixingCommitSha: FIX_SHA, disposition: "deferred", fingerprint: ACT_FP,
      returnedSites: ["--flag"], sites: [{ site: "--flag", kind: "input_form", status: "fixed", test: "legacy form test" }] }];
    const fixerPlan = await deliver(repoRoot, dispositions, { actList });
    const mock = runtime([threadsCallEntry([actThread("PRRT_LEGACY", [gateComment("c1", 1)])]), userEntry], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, mock.deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const kind of ["resolved", "mixed", "repeated-mixed", "residual", "threadless"]) test(`typed completion constructs exact authenticated coverage and shared-root dispositions (${kind})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot, kind);
    await rm(f.plan.workOrder.outputRefs[0]);
    await rm(`${f.plan.workOrder.outputRefs[0]}.constructed`);
    const options = { repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: true };
    const mock = f.depsFor();
    const constructed = await verifyFixerDisposition(options, mock.deps);
    assert.equal(constructed.constructed, true);
    assert.equal(constructed.complete, undefined);
    assert.equal(constructed.outputRef, f.plan.workOrder.outputRefs[0]);
    const raw = JSON.parse(await readFile(constructed.outputRef, "utf8"));
    assert.deepEqual(raw, { headSha: f.candidate, dispositions: f.dispositions, siteCoverage: f.source.siteCoverage });
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(mock.calls), false);
    for (const check of [false, true]) {
      const next = f.depsFor(f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead", f.candidate)] : []);
      const verified = await verifyFixerDisposition({ ...options, construct: false, check }, next.deps);
      assertCompleteModuloResidual(verified, check);
      assert.deepEqual(nonResidual(verified.actions), []);
      assert.equal(hasPost(next.calls), false);
    }
    const parsedThreads = parseReviewThreads(JSON.parse(threadsPayload(f.nodes)));
    const resolver = f.depsFor([...f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead", f.candidate)] : [], ...f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead", f.candidate)] : []]);
    assert.equal((await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: f.candidate, parsedThreads }, resolver.deps)).complete, !f.dispositions.some((entry) => entry.disposition === "deferred"));
  });
});

for (const defect of ["partial", "duplicateRead", "optionalRead", "semantic", "bytes", "byteAuthority", "sourceHead", "fixingHead", "originIdentity", "originRef", "originDigest", "originReceipt", "originSubject", "originOutput", "originCoverage", "originPrePull", "deltaCoverage", "decisionCoverage", "baselineContainment", "fixContainment", "duplicateRoot", "duplicateMember", "emptyMembers", "unknownMember", "omittedRoot", "omittedMember", "foreignRoot", "unmarkedRoot", "replyMarker", "residualResolved", "unaccountedForm", "skippedForm", "prePull", "currentReceipt", "currentSubject", "currentPath", "outputPath", "outputSymlink", "directorySymlink", "role", "target", "planDigest", "noSource", "noDelta", "sourceAuthority"]) {
  test(`typed completion refuses ${defect} without output/checkpoint/GitHub writes`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const f = await completionFixture(repoRoot, defect === "residualResolved" ? "mixed" : "resolved");
      if (defect === "sourceHead") f.source.headSha = FIX_SHA;
      if (defect === "fixingHead") f.source.fixingCommitSha = "abc1234";
      if (defect === "originIdentity") f.source.origin.executionIdentity = f.plan.executionIdentity;
      if (defect === "originRef") f.source.origin.workOrderRef = f.plan.workOrderRef;
      if (defect === "originDigest") f.source.origin.workOrderDigest = "sha256:wrong";
      if (defect === "duplicateRoot") f.source.threadBindings.push(f.source.threadBindings[0]);
      if (defect === "duplicateMember") f.source.threadBindings[0].fingerprints.push(ACT_FP);
      if (defect === "emptyMembers") f.source.threadBindings[0].fingerprints = [];
      if (defect === "unknownMember") f.source.threadBindings[0].fingerprints.push("1111111111111111");
      if (defect === "omittedRoot") f.source.threadBindings.pop();
      if (defect === "omittedMember") f.source.threadBindings[0].fingerprints.pop();
      if (defect === "unaccountedForm" || defect === "skippedForm") {
        // Deliberate corruption after genuine construction: reseal identity to reach the form guard.
        if (defect === "unaccountedForm") f.source.siteCoverage[0].sites.shift();
        else Object.assign(f.source.siteCoverage[0].sites[0], { status: "skipped", reason: "unverified resolved form" });
        const prior = { headSha: f.fixing, siteCoverage: f.source.siteCoverage }, priorBytes = Buffer.from(JSON.stringify(prior));
        await writeFile(f.originPath, priorBytes);
        const binding = { siteCoverageDigest: sha256Hex(prior.siteCoverage).slice(7), handbackBytesDigest: sha256Hex(priorBytes).slice(7) };
        const deltaRead = f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result");
        const delta = { ...JSON.parse(await readFile(deltaRead.path)), ...binding }, bytes = Buffer.from(JSON.stringify(delta));
        await writeFile(deltaRead.path, bytes);
        Object.assign(deltaRead, { sha256: sha256Hex(bytes).slice(7), bytes: bytes.length });
        f.plan.workOrder.authority.deltaResultDigest = sha256Hex(delta).slice(7);
        const decisionPath = path.join(repoRoot, "tmp/gate-delta", `${f.baseline}.json`);
        await writeFile(decisionPath, JSON.stringify({ ...JSON.parse(await readFile(decisionPath)), ...binding }));
      }
      await f.seal();
      if (defect === "partial") delete f.plan.workOrder.authority.completionInputDigest;
      if (defect === "duplicateRead") f.plan.workOrder.requiredReads.push(f.sourceRead);
      if (defect === "optionalRead") f.sourceRead.required = false;
      if (defect === "semantic") f.plan.workOrder.authority.completionInputDigest = "0".repeat(64);
      if (defect === "byteAuthority") f.plan.workOrder.authority.completionInputBytesDigest = "0".repeat(64);
      if (defect === "noSource") { f.plan.workOrder.requiredReads.pop(); delete f.plan.workOrder.authority.completionInputDigest; delete f.plan.workOrder.authority.completionInputBytesDigest; }
      if (defect === "noDelta") f.plan.workOrder.requiredReads = f.plan.workOrder.requiredReads.filter((read) => read.kind !== "delta-result");
      if (defect === "sourceAuthority") delete f.plan.workOrder.authority.sourceDigest;
      if (defect === "role") f.plan.workOrder.role = "judge";
      if (defect === "target") f.plan.workOrder.target.pr++;
      if (defect === "outputPath") f.plan.workOrder.outputRefs[0] = path.join(repoRoot, "other.json");
      f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder);
      const currentReceiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), f.plan.workOrderRef);
      const current = JSON.parse(await readFile(currentReceiptPath, "utf8"));
      current.workOrderDigest = f.plan.workOrderDigest;
      if (defect === "currentSubject") current.subject.phase = "commit_only";
      if (defect === "currentPath") current.subject.planPath = path.join(repoRoot, "other-plan.json");
      await writeFile(currentReceiptPath, JSON.stringify(current));
      if (defect === "currentReceipt") await rm(currentReceiptPath);
      if (defect === "planDigest") f.plan.workOrderDigest = "sha256:wrong";
      await writeFile(f.fixerPlan, JSON.stringify(f.plan));
      if (defect === "bytes") await writeFile(f.sourcePath, `${await readFile(f.sourcePath, "utf8")} `);
      const originReceiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), f.source.origin.workOrderRef);
      if (defect === "originReceipt") await rm(originReceiptPath);
      if (defect === "originSubject") { const receipt = JSON.parse(await readFile(originReceiptPath, "utf8")); receipt.subject.headSha = HEAD_SHA; await writeFile(originReceiptPath, JSON.stringify(receipt)); await utimes(originReceiptPath, 1, 1); }
      if (defect === "originOutput") await writeFile(f.originPath, JSON.stringify({ headSha: FIX_SHA, dispositions: [], siteCoverage: f.source.siteCoverage }));
      if (defect === "originCoverage") await writeFile(f.originPath, JSON.stringify({ headSha: f.fixing, dispositions: [], siteCoverage: [] }));
      if (defect === "originPrePull") await utimes(f.originPath, 1, 1);
      if (["deltaCoverage", "decisionCoverage"].includes(defect)) {
        const file = defect === "deltaCoverage" ? f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").path : path.join(repoRoot, "tmp", "gate-delta", `${f.baseline}.json`);
        const value = JSON.parse(await readFile(file, "utf8")); value.siteCoverageDigest = "0".repeat(64);
        await writeFile(file, JSON.stringify(value));
        if (defect === "deltaCoverage") {
          f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").sha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
          f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").bytes = Buffer.byteLength(JSON.stringify(value));
          f.plan.workOrder.authority.deltaResultDigest = sha256Hex(value).slice(7);
          f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder); current.workOrderDigest = f.plan.workOrderDigest;
          await writeFile(f.fixerPlan, JSON.stringify(f.plan)); await writeFile(currentReceiptPath, JSON.stringify(current));
        }
      }
      if (defect === "foreignRoot") f.nodes[0].comments.nodes[0].author.login = "foreign";
      if (defect === "unmarkedRoot") f.nodes[0].comments.nodes[0].body = "no marker";
      if (defect === "replyMarker") f.nodes[0].comments.nodes.unshift(gateComment("c0", 0, "unmarked root"));
      if (defect === "residualResolved") f.nodes[0].isResolved = true;
      const canonical = path.join(path.dirname(f.fixerPlan), f.plan.executionIdentity, "fixer-disposition.json");
      if (defect === "prePull") await utimes(canonical, 1, 1); else await rm(canonical);
      if (["outputSymlink", "directorySymlink"].includes(defect)) {
        const other = path.join(repoRoot, "unrelated");
        await mkdir(other);
        await writeFile(path.join(other, "fixer-disposition.json"), "must remain unchanged");
        if (defect === "directorySymlink") { await rm(path.dirname(canonical), { recursive: true }); await symlink(other, path.dirname(canonical), "dir"); }
        else await symlink(path.join(other, "fixer-disposition.json"), canonical);
      }
      const evidenceBefore = await Promise.all([f.originPath, f.sourcePath].map((file) => readFile(file, "utf8").catch(() => null)));
      const before = existsSync(canonical) ? await readFile(canonical, "utf8") : null;
      const entries = [compareEntry(f.baseline, defect === "baselineContainment" ? "diverged" : "ahead", f.candidate), compareEntry(f.fixing, defect === "fixContainment" ? "diverged" : "ahead", f.candidate), liveHeadEntry(f.candidate), threadsCallEntry(f.nodes), userEntry];
      const mock = runtime(entries, repoRoot, { live: false });
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: f.candidate, fixerPlan: f.fixerPlan, construct: true }, mock.deps),
        ["unaccountedForm", "skippedForm"].includes(defect) ? /GATE-EXEC-REMEDIATION-SITE-QUERY/ : undefined);
      assert.equal(existsSync(canonical) ? await readFile(canonical, "utf8") : null, before);
      assert.deepEqual(await Promise.all([f.originPath, f.sourcePath].map((file) => readFile(file, "utf8").catch(() => null))), evidenceBefore);
      assert.deepEqual(await checkpointFiles(repoRoot), []);
      assert.equal(hasPost(mock.calls), false);
    });
  });
}

for (const mismatched of [false, true]) {
  test(`locally-clear full completion ${mismatched ? "rejects a mismatched" : "accepts a whitespace-padded current"} result candidate`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
      const sequence = startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList });
      const siteCoverage = [{ fingerprint: ACT_FP, returnedSites: ["--flag"], sites: [{ site: "--flag", kind: "input_form", status: "fixed", test: "targeted form test" }] }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: ` ${HEAD_SHA} `, actSetId: sequence.actSetId, actionableItems: [{ ref: ACT_FP, status: "resolved", evidence: ["targeted check"] }], newFindings: [], widenedReads: [], outcome: "locally_clear" };
      const next = decideDeltaNextStep({ sequence, result: delta, invocation: 1, currentHead: HEAD_SHA, siteCoverage });
      assert.equal(next.outcome, "locally_clear");
      assert.equal(next.nextStep, "push");
      const decision = { ...next, reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, invocation: 1, items: delta.actionableItems };
      if (mismatched) delta.candidateHead = ` ${FIX_SHA} `;
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions: [], siteCoverage });
      const fixerPlan = await deliver(repoRoot, [], { actList, delta, decision, handoffText });
      const { deps, calls } = runtime([threadsCallEntry([]), userEntry], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
      if (mismatched) {
        await assert.rejects(verify(), /neither locally clear nor invocation-three bounded_out/);
        assert.equal(calls.length, 0);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        assert.equal((await verify()).complete, true);
        assert.equal((await checkpointFiles(repoRoot)).length, 1);
      }
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const check of [false, true]) for (const defect of [null, "missing", "nonclearing", "source", "delta", "bytes", "baseline", "membership", "statuses", "candidate", "invocation", "tackled", "resolved", "resolvedForms", "unaccounted", "unbound", "residualResolved", "residualResolvedOmitted", "residualUnmarked", "residualForeign", "residualMissing", "legacy"]) {
  test(`bounded-out full completion authenticates residual authority (${check}, ${defect})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: FIX_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: [{ ref: ACT_FP, status: "not_resolved", evidence: ["still fails"] }], newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items: [{ ref: ACT_FP, status: "not_resolved" }] };
      if (defect === "nonclearing") decision.nextStep = "fix_and_rereview";
      if (defect === "baseline") delta.reviewBaselineHead = FIX_SHA;
      if (defect === "membership") delta.actionableItems[0].ref = "foreign";
      if (defect === "statuses") decision.items[0].status = "cannot_verify";
      if (defect === "candidate") decision.candidateHead = FIX_SHA;
      if (defect === "invocation") decision.invocation = 2;
      if (["resolved", "resolvedForms"].includes(defect)) { delta.actionableItems[0].status = "resolved"; decision.items[0].status = "resolved"; }
      const dispositions = [{ threadId: "PRRT_RESIDUAL", fingerprint: defect === "unbound" ? null : ACT_FP, fixingCommitSha: HEAD_SHA, disposition: ["tackled", "resolvedForms", "unbound"].includes(defect) ? "tackled" : "deferred", returnedSites: ["--flag"], sites: defect === "unaccounted" ? [] : [{ site: "--flag", kind: "input_form", status: "skipped", reason: "still fails after invocation three" }] }];
      const handoffText = ["unbound", "residualResolvedOmitted"].includes(defect) ? JSON.stringify({ headSha: HEAD_SHA, dispositions: defect === "residualResolvedOmitted" ? [] : dispositions, siteCoverage: [{ ...dispositions[0], fingerprint: ACT_FP }] }) : null;
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision: defect === "missing" ? null : decision, semanticAuthority: defect !== "legacy", handoffText });
      if (["source", "delta", "bytes"].includes(defect)) {
        const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
        const read = plan.workOrder.requiredReads.find((entry) => entry.kind === (defect === "source" ? "act-list" : "delta-result"));
        const altered = defect === "source" ? [{ ...actList[0], summary: "tampered" }] : { ...delta, newFindings: [{ severity: "low", summary: "tampered", evidence: ["x"] }] };
        await writeFile(read.path, JSON.stringify(altered));
        if (defect !== "bytes") read.sha256 = createHash("sha256").update(JSON.stringify(altered)).digest("hex");
        assert.equal(workOrderDigest(plan.workOrder), plan.workOrderDigest, "local byte hashes cannot change semantic authority");
        await writeFile(fixerPlan, JSON.stringify(plan));
      }
      const root = gateComment("c1", 1);
      if (defect === "residualUnmarked") root.body = "Unmarked review finding";
      if (defect === "residualForeign") root.author.login = "reviewer";
      const resolvedResidual = ["residualResolved", "residualResolvedOmitted", "residualUnmarked", "residualForeign"].includes(defect);
      const nodes = defect === "residualMissing" ? [] : [actThread("PRRT_RESIDUAL", [root], resolvedResidual)];
      const { deps, calls, residualPosts } = runtime([threadsCallEntry(nodes), userEntry], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (defect) {
        const expected = { missing: /delta clearing decision/, nonclearing: /delta clearing decision/, source: /authority.sourceDigest/, delta: /authority.deltaResultDigest/, bytes: /delta result differs from its sha256/, baseline: /pinned baseline/, membership: /not in the act set/, statuses: /delta clearing decision/, candidate: /actual pushed candidate/, invocation: /invocation-three/, tackled: /delta status and live thread disposition disagree/, resolved: /fixed status and a test/, resolvedForms: /fixed status and a test/, unaccounted: /returned site/, unbound: /delta status and live thread disposition disagree/, residualResolved: /delta status and live thread disposition disagree/, residualResolvedOmitted: /delta status and live thread disposition disagree/, legacy: /fixed status and a test/ };
        const before = await readFile(fixerPlan, "utf8");
        await assert.rejects(verify(), ["residualUnmarked", "residualForeign", "residualMissing"].includes(defect) ? /delta status and live thread disposition disagree/ : expected[defect]);
        assert.equal(ghCount(calls), defect === "tackled" || defect === "unbound" || resolvedResidual || defect === "residualMissing" ? 3 : 0, "authority fails before GitHub mutation or checkpoint");
        assert.deepEqual(await checkpointFiles(repoRoot), []);
        assert.equal(await readFile(fixerPlan, "utf8"), before);
      } else {
        const before = await readFile(fixerPlan, "utf8");
        const result = await verify();
        assertCompleteModuloResidual(result, check);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal(nodes[0].isResolved, false);
        assert.equal(ghCount(calls), 3);
        assert.equal(residualPosts.length, check ? 0 : 1, "the ACT route posts its authoritative residual status even with no delta record on disk");
        assert.equal(await readFile(fixerPlan, "utf8"), before);
        if (check) assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
    });
  });
}

for (const check of [false, true]) for (const kind of ["threadless-mixed", "threadless-fixed", "live-mixed", "live-deferred", "residual", "resolved"]) {
  test(`repeated fingerprint completion preserves ref statuses (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const refuses = kind.endsWith("mixed");
      const live = !kind.startsWith("threadless");
      const fixed = kind === "threadless-fixed" || kind === "live-mixed" || kind === "resolved";
      const actList = ["--first", "--second"].map((form) => ({ ...ACT_LIST[0], siteQuery: "query", acceptedForms: [form] }));
      const statuses = !live ? ["not_resolved", "resolved"] : ["live-mixed", "live-deferred"].includes(kind) ? ["resolved", "cannot_verify"] : kind === "resolved" ? ["resolved", "resolved"] : ["not_resolved", "cannot_verify"];
      const items = statuses.map((status, index) => ({ ref: index ? `${ACT_FP}#2` : ACT_FP, status }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: FIX_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const dispositions = live ? [{ threadId: "PRRT_REPEAT", fixingCommitSha: HEAD_SHA, disposition: fixed ? "tackled" : "deferred" }] : [];
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage: [{ fingerprint: ACT_FP, returnedSites: ["--first", "--second"], sites: ["--first", "--second"].map((site, index) => ({ site, kind: "input_form", status: fixed || (kind === "live-deferred" && index === 0) ? "fixed" : "skipped", ...(fixed || (kind === "live-deferred" && index === 0) ? { test: "targeted form test" } : { reason: "still fails at invocation three" }) })) }] });
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, handoffText });
      const nodes = live ? [actThread("PRRT_REPEAT", [gateComment("c1", 1, `${ACT_MARKER}\n${fixed ? `Fixed in commit ${HEAD_SHA}.` : "still fails"}`)], fixed)] : [];
      const { deps, calls } = runtime([threadsCallEntry(nodes), userEntry, ...(live && fixed ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const before = await readFile(fixerPlan, "utf8");
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (refuses) {
        await assert.rejects(verify(), live ? /delta status and live thread disposition disagree/ : /fixed status and a test/);
        assert.equal(ghCount(calls), live ? 3 : 0, "refuses before checkpoint or GitHub mutation");
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assertCompleteModuloResidual(result, check);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal(ghCount(calls), live && fixed ? 4 : 3);
        if (check) assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
      assert.equal(await readFile(fixerPlan, "utf8"), before);
    });
  });
}

for (const check of [false, true]) for (const [kind, statuses, disposition, member] of [
  ["resolved-first", ["resolved", "resolved"], "tackled", 0],
  ["resolved-second", ["resolved", "resolved"], "tackled", 1],
  ["residual-first", ["not_resolved", "cannot_verify"], "deferred", 0],
  ["residual-second", ["not_resolved", "cannot_verify"], "deferred", 1],
  ["foreign", ["resolved", "resolved", "resolved"], "tackled", 2],
  ["unknown-hint", ["resolved", "not_resolved"], "deferred", 2],
  ["mixed-tackled", ["resolved", "not_resolved"], "tackled", 0],
  ["mixed-deferred", ["resolved", "not_resolved"], "deferred", 1],
  ["mixed-resolved-hint", ["resolved", "not_resolved"], "deferred", 0],
  ["mixed-no-hint", ["resolved", "cannot_verify"], "deferred", null],
  ["resolved-deferred", ["resolved", "resolved"], "deferred", 0],
  ["resolved-residual", ["not_resolved", "cannot_verify"], "deferred", 0],
  ["incomplete-coverage", ["resolved", "resolved"], "tackled", 0],
]) {
  test(`distinct merged fingerprints validate every member (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fingerprints = [ACT_FP, "fedcba9876543210", "1111111111111111"];
      const actList = statuses.map((status, index) => ({ ...ACT_LIST[0], fingerprint: fingerprints[index], siteQuery: "query", acceptedForms: [`--member-${index}`] }));
      const items = statuses.map((status, index) => ({ ref: fingerprints[index], status }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const dispositions = [{ threadId: "PRRT_MERGED", fingerprint: member === null ? undefined : fingerprints[member], fixingCommitSha: HEAD_SHA, disposition }];
      const siteCoverage = actList.map((item, index) => ({ fingerprint: item.fingerprint, returnedSites: item.acceptedForms, sites: item.acceptedForms.map((site) => ({ site, kind: "input_form", status: statuses[index] === "resolved" ? "fixed" : "skipped", ...(statuses[index] === "resolved" ? { test: "targeted member test" } : { reason: "still fails at invocation three" }) })) }));
      if (kind === "incomplete-coverage") siteCoverage[1].sites = [];
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage });
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, handoffText });
      const fixed = disposition === "tackled";
      const root = `${ACT_MARKER}\n${ACT_MARKER.replace(ACT_FP, fingerprints[1])}\n**Problem:** merged members`;
      const nodes = [actThread("PRRT_MERGED", [gateComment("c1", 1, root), ...(fixed ? [gateComment("c2", 2, `Fixed in commit ${HEAD_SHA}.`)] : [])], fixed || kind === "resolved-residual")];
      const { deps, calls } = runtime([threadsCallEntry(nodes), userEntry, ...(fixed ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const before = await readFile(fixerPlan, "utf8");
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (["foreign", "unknown-hint", "mixed-tackled", "resolved-deferred", "resolved-residual", "incomplete-coverage"].includes(kind)) {
        await assert.rejects(verify(), kind === "incomplete-coverage" ? /returned site/ : /delta status and live thread disposition disagree/);
        assert.equal(ghCount(calls), kind === "incomplete-coverage" ? 0 : 3);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assertCompleteModuloResidual(result, check);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal(ghCount(calls), fixed ? 4 : 3);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
      }
      assert.equal(hasPost(calls), false);
      assert.equal(await readFile(fixerPlan, "utf8"), before);
    });
  });
}

async function checkpointFiles(repoRoot) {
  const entries = await readdir(path.join(repoRoot, "tmp"), { recursive: true }).catch(() => []);
  return entries.filter((entry) => path.basename(entry).startsWith("fixer-disposition-"));
}

for (const check of [false, true]) for (const kind of ["resolved", "residual", "omitted-open", "omitted-resolved", "unknown", "missing-status", "unmarked", "foreign", "reply-only"]) {
  test(`shared fingerprint roots preserve authenticated membership (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const status = ["resolved", "omitted-resolved"].includes(kind) ? "resolved" : kind === "unknown" ? "unknown" : "cannot_verify";
      const items = kind === "missing-status" ? [] : [{ ref: ACT_FP, status }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList: ACT_LIST }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const resolved = status === "resolved";
      const dispositions = ["PRRT_A", "PRRT_B"].map((threadId) => ({ threadId, fingerprint: ACT_FP, fixingCommitSha: HEAD_SHA, disposition: resolved ? "tackled" : "deferred" }));
      if (kind.startsWith("omitted")) dispositions.pop();
      const fixerPlan = await deliver(repoRoot, dispositions, { actList: ACT_LIST, delta, decision });
      const nodes = ["PRRT_A", "PRRT_B"].map((id, index) => actThread(id, [gateComment(`c${index}`, 100 + index, `${ACT_MARKER}\n${resolved ? `Fixed in commit ${HEAD_SHA}.` : "residual"}`)], resolved));
      if (kind === "unmarked" || kind === "reply-only") nodes[1].comments.nodes[0].body = "no root marker";
      if (kind === "reply-only") nodes[1].comments.nodes.push(gateComment("c9", 109));
      if (kind === "foreign") nodes[1].comments.nodes[0].author.login = "someone-else";
      const entries = [threadsCallEntry(nodes), userEntry, ...(resolved && !kind.startsWith("omitted") ? [compareEntry(HEAD_SHA, "identical")] : [])];
      const { deps, calls } = runtime(entries, repoRoot);
      const promise = verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (["resolved", "residual"].includes(kind)) {
        const result = await promise;
        assertCompleteModuloResidual(result, check);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
        if (!check) {
          const checkpoint = JSON.parse(await readFile(path.resolve(repoRoot, result.checkpointPath), "utf8"));
          assert.equal(checkpoint.dispositions.length, 2);
          const { deps } = runtime([...entries, ...(resolved ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
          const shared = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA, parsedThreads: parseReviewThreads(JSON.parse(threadsPayload(nodes))) }, deps);
          assert.equal(shared.complete, kind !== "residual");
        }
      } else {
        await assert.rejects(promise, kind.startsWith("omitted") ? /no disposition entry.*PRRT_B/ : ["unknown", "missing-status"].includes(kind) ? /Invalid delta result/ : /delta status and live thread disposition disagree/);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
      assert.equal(hasPost(calls), false);
      assert.equal(calls.some(({ args }) => args.some((arg) => String(arg).includes("mutation"))), false);
    });
  });
}

test("a full-phase handoff that omits a disposition entry for an open gate thread carrying a judge-act fingerprint fails, names the thread and writes no checkpoint", async () => {
  const liveThreads = threadsCallEntry([actThread("PRRT_ACT", [gateComment("c1", 101)])]);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([liveThreads, userEntry], repoRoot);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
      /PRRT_ACT/,
    );
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_ACT", fixingCommitSha: FIX_SHA, disposition: "tackled" }], { actList: ACT_LIST });
    const { deps } = runtime([
      liveThreads,
      userEntry,
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_ACT", isResolved: true } } } })}\n` },
      threadsCallEntry([
        actThread("PRRT_ACT", [gateComment("c1", 101), { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }], true),
      ]),
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
  });
});

test("an act item with no fingerprint field is matched by its derived fingerprint, so an undispositioned open gate thread still fails", async () => {
  const derived = fingerprintFinding({ summary: "s" });
  const marker = ACT_MARKER.replace(ACT_FP, derived);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: [{ severity: "medium", summary: "s", judgeDisposition: "act" }] });
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_DERIVED", [gateComment("c1", 103, `${marker}\n**Problem:** s`)])]), userEntry], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), /PRRT_DERIVED/);
  });
});

for (const check of [false, true]) for (const kind of ["resolved", "resolved-deferred", "residual-hint", "repeated-mixed"]) {
  test(`derived fingerprint roots use authenticated Delta statuses (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const derived = fingerprintFinding({ summary: "s" });
      const actList = kind === "repeated-mixed"
        ? ["first", "second"].map((ref) => ({ ref, severity: "medium", summary: "s", judgeDisposition: "act" }))
        : [{ severity: "medium", summary: "s", judgeDisposition: "act" }];
      const sequence = startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList });
      const items = sequence.actItems.map(({ ref }, index) => ({ ref, status: kind === "residual-hint" || (kind === "repeated-mixed" && index === 1) ? "cannot_verify" : "resolved" }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const tackled = kind === "resolved";
      const dispositions = [{ threadId: "PRRT_DERIVED", ...(kind === "residual-hint" ? { fingerprint: derived } : {}), fixingCommitSha: HEAD_SHA, disposition: tackled ? "tackled" : "deferred" }];
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision });
      const body = `${ACT_MARKER.replace(ACT_FP, derived)}\n${tackled ? `Fixed in commit ${HEAD_SHA}.` : "residual"}`;
      const { deps, calls } = runtime([threadsCallEntry([actThread("PRRT_DERIVED", [gateComment("c1", 103, body)], tackled)]), userEntry, ...(tackled ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (kind === "resolved-deferred") {
        await assert.rejects(verify(), /delta status and live thread disposition disagree/);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assertCompleteModuloResidual(result, check);
        assert.deepEqual(nonResidual(result.actions), []);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
      }
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const check of [false, true]) for (const kind of ["foreign", "unmarked", "unbound"]) {
  test(`semantic ACT delivery refuses unauthenticated roots without scalar hints (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const items = [{ ref: ACT_FP, status: "resolved" }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList: ACT_LIST }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["check"] })), newFindings: [], widenedReads: [], outcome: "locally_clear" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 1, outcome: "locally_clear", nextStep: "push", items };
      const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_EXTRA", fixingCommitSha: HEAD_SHA, disposition: "tackled" }], { actList: ACT_LIST, delta, decision });
      const root = gateComment("c1", 101, kind === "unmarked" ? "No marker" : kind === "unbound" ? ACT_MARKER.replace(ACT_FP, "fedcba9876543210") : ACT_MARKER, kind === "foreign" ? "reviewer" : "gate");
      const { deps, calls } = runtime([
        threadsCallEntry([actThread("PRRT_EXTRA", [root])]), userEntry, compareEntry(HEAD_SHA, "identical"),
        { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
        { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_EXTRA", isResolved: true } } } })}\n` },
        threadsCallEntry([actThread("PRRT_EXTRA", [root, gateComment("c2", 102, `Fixed in commit ${HEAD_SHA}.`)], true)]),
      ], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), /delta status and live thread disposition disagree/);
      assert.deepEqual(await checkpointFiles(repoRoot), []);
      assert.equal(hasPost(calls), false);
      assert.equal(calls.some(({ args }) => args.some((arg) => String(arg).includes("mutation"))), false);
    });
  });
}

test("an act item matching a non-primary marker of a merged gate thread root still fails naming the thread", async () => {
  const merged = `<!-- dev-loops:finding fedcba9876543210 severity=medium angle=correctness round=1 -->\n${ACT_MARKER}\n**Problem:** s`;
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_MERGED", [gateComment("c1", 104, merged)])]), userEntry], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), /PRRT_MERGED/);
  });
});

// Two open gate threads carrying one act fingerprint: each needs its own entry, whatever the API order.
for (const [name, listOrder, dispositioned] of [
  ["only the API-last thread dispositioned", ["PRRT_A", "PRRT_B"], "PRRT_B"],
  ["only the API-first thread dispositioned", ["PRRT_A", "PRRT_B"], "PRRT_A"],
]) {
  test(`two open gate threads on one act fingerprint fail naming the undispositioned one (${name})`, async () => {
    const missing = dispositioned === "PRRT_A" ? "PRRT_B" : "PRRT_A";
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [{ threadId: dispositioned, fixingCommitSha: FIX_SHA, disposition: "tackled" }], { actList: ACT_LIST });
      const { deps } = runtime([
        threadsCallEntry(listOrder.map((id, i) => actThread(id, [gateComment(`c${i}`, 200 + i)]))),
        userEntry,
      ], repoRoot);
      await assert.rejects(
        verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
        new RegExp(missing),
      );
    });
  });
}

test("the act-thread guard finds the root by databaseId when a reply's node id sorts first", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([
      threadsCallEntry([actThread("PRRT_ACT", [gateComment("c9", 401), gateComment("c1", 402, "reply without marker")])]),
      userEntry,
    ], repoRoot);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
      /PRRT_ACT/,
    );
  });
});

test("two open gate threads on one act fingerprint, both dispositioned, pass the act-thread guard", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_A", fixingCommitSha: FIX_SHA, disposition: "deferred" },
      { threadId: "PRRT_B", fixingCommitSha: FIX_SHA, disposition: "deferred" },
    ], { actList: ACT_LIST });
    const { deps } = runtime([
      threadsCallEntry([actThread("PRRT_A", [gateComment("c1", 201)]), actThread("PRRT_B", [gateComment("c2", 202)])]),
      userEntry,
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete, []);
  });
});

// Only a thread whose ROOT comment is authored by the gate login is an act thread.
for (const [name, nodes, isResolved] of [
  ["a root comment authored by a non-gate login quoting the marker", [gateComment("c1", 301, undefined, "someone-else")]],
  ["a marker only on a reply comment, not the root", [gateComment("c1", 302, "root without marker"), gateComment("c2", 303)]],
  ["a resolved gate thread carrying the act fingerprint", [gateComment("c1", 304)], true],
  ["an open gate thread whose fingerprint is not on the act list", [gateComment("c1", 305, ACT_MARKER.replace(ACT_FP, "fedcba9876543210"))]],
]) {
  test(`the act-thread guard ignores ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
      const { deps } = runtime([threadsCallEntry([actThread("PRRT_FOREIGN", nodes, isResolved)]), userEntry], repoRoot);
      const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
      assert.equal(result.ok, true);
    });
  });
}

// bounded_out THREAD full order: the verifier's normal mode posts one residual-status reply and leaves the thread open.
test("bounded_out THREAD normal mode posts one residual reply on a not_resolved thread, leaves it open and posts nothing on re-entry", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root, { outcome: "bounded_out", nextStep: "push_to_gate", invocation: 3, items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")).dispositions, [{ threadId: "PRRT_T1", fixingCommitSha: f.head, disposition: "deferred" }]);
    const reviewer = { id: "c1", databaseId: 1, body: "please fix", author: { login: "reviewer", __typename: "User" } };
    const withGit = (mock) => {
      const inner = mock.deps.runChild;
      mock.deps.runChild = async (cmd, args = [], ...rest) => (cmd === "git" ? (mock.calls.push({ command: cmd, args: [...args], stdinText: "" }), { code: 0, stderr: "", stdout: `${f.head}\n` }) : inner(cmd, args, ...rest));
      return mock;
    };
    const first = withGit(f.runtimeFor([
      threadsCallEntry([{ id: "PRRT_T1", isResolved: false, comments: { nodes: [reviewer] } }]), ...ciEntries(f.head),
    ]));
    const result = await verifyFixerDisposition(f.options, first.deps);
    assert.deepEqual(result.actions, [{ threadId: "PRRT_T1", ok: true, step: "residual_replied" }]);
    assert.equal(first.residualPosts.length, 1);
    assert.ok(first.residualPosts[0].args.includes(`repos/${REPO}/pulls/${PR}/comments/1/replies`));
    assert.equal(first.calls.some((call) => JSON.stringify(call.args).includes("resolveReviewThread")), false, "the thread stays open");
    const residual = { id: "c2", databaseId: 2, body: `Residual delta status: not_resolved after the delta review of commit ${f.head}.`, author: { login: "bot", __typename: "User" } };
    const again = withGit(f.runtimeFor([threadsCallEntry([{ id: "PRRT_T1", isResolved: false, comments: { nodes: [reviewer, residual] } }]), ...ciEntries(f.head)]));
    const reentry = await verifyFixerDisposition(f.options, again.deps);
    assert.deepEqual(nonResidual(reentry.actions), []);
    assert.equal(again.residualPosts.length, 0, "no second residual reply");
  });
});

// A failed residual POST is not delivery: incomplete + ok:false naming the thread, and a clean re-run posts it once.
// A marker from an earlier round's commit does not suppress this round's status.
test("bounded_out THREAD residual POST failure is incomplete and ok:false; clean re-run posts once; an earlier-round marker does not suppress", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root, { outcome: "bounded_out", nextStep: "push_to_gate", invocation: 3, items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const reviewer = { id: "c1", databaseId: 1, body: "please fix", author: { login: "reviewer", __typename: "User" } };
    const withGit = (mock) => {
      const inner = mock.deps.runChild;
      mock.deps.runChild = async (cmd, args = [], ...rest) => (cmd === "git" ? (mock.calls.push({ command: cmd, args: [...args], stdinText: "" }), { code: 0, stderr: "", stdout: `${f.head}\n` }) : inner(cmd, args, ...rest));
      return mock;
    };
    const open = (...extra) => [threadsCallEntry([{ id: "PRRT_T1", isResolved: false, comments: { nodes: [reviewer, ...extra] } }]), ...ciEntries(f.head)];
    const failing = await verifyFixerDisposition(f.options, withGit(f.runtimeFor(open(), undefined, { failResidual: true })).deps);
    assert.equal(failing.ok, false);
    assert.equal(failing.complete, false);
    assert.ok(failing.incomplete.some((entry) => entry.threadId === "PRRT_T1" && entry.failedStep === "residual_reply_failed"));
    assert.match(failing.reason, /PRRT_T1/);
    const stale = { id: "c2", databaseId: 2, body: `Residual delta status: not_resolved after the delta review of commit ${"a".repeat(40)}; stays open.`, author: { login: "bot", __typename: "User" } };
    const rerun = withGit(f.runtimeFor(open(stale)));
    const posted = await verifyFixerDisposition(f.options, rerun.deps);
    assert.equal(posted.ok, true);
    assert.equal(rerun.residualPosts.length, 1, "the earlier commit's marker does not suppress this round");
    const current = { ...stale, body: `Residual delta status: not_resolved after the delta review of commit ${f.head}; stays open.` };
    const again = withGit(f.runtimeFor(open(current)));
    await verifyFixerDisposition(f.options, again.deps);
    assert.equal(again.residualPosts.length, 0);
  });
});

// After a failed residual POST, --check must not report complete until the reply is observed live.
test("bounded_out THREAD failed residual POST stays incomplete under --check; clean re-run posts once and --check then passes", async () => {
  await withRepoRoot(async (root) => {
    const f = await threadConstructFixture(root, { outcome: "bounded_out", nextStep: "push_to_gate", invocation: 3, items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    await verifyFixerDisposition({ ...f.options, construct: true }, f.runtimeFor([threadsCallEntry([])]).deps);
    const reviewer = { id: "c1", databaseId: 1, body: "please fix", author: { login: "reviewer", __typename: "User" } };
    const withGit = (mock) => {
      const inner = mock.deps.runChild;
      mock.deps.runChild = async (cmd, args = [], ...rest) => (cmd === "git" ? (mock.calls.push({ command: cmd, args: [...args], stdinText: "" }), { code: 0, stderr: "", stdout: `${f.head}\n` }) : inner(cmd, args, ...rest));
      return mock;
    };
    const open = (...extra) => [threadsCallEntry([{ id: "PRRT_T1", isResolved: false, comments: { nodes: [reviewer, ...extra] } }]), ...ciEntries(f.head)];
    const failing = await verifyFixerDisposition(f.options, withGit(f.runtimeFor(open(), undefined, { failResidual: true })).deps);
    assert.equal(failing.complete, false);
    const check = await verifyFixerDisposition({ ...f.options, check: true }, withGit(f.runtimeFor(open())).deps);
    assert.equal(check.complete, false);
    assert.equal(check.ok, false);
    assert.ok(check.incomplete.some((entry) => entry.threadId === "PRRT_T1" && entry.failedStep === "residual_reply_failed"));
    const rerun = withGit(f.runtimeFor(open()));
    assert.equal((await verifyFixerDisposition(f.options, rerun.deps)).ok, true);
    assert.equal(rerun.residualPosts.length, 1);
    const live = { id: "c2", databaseId: 2, body: `Residual delta status: not_resolved after the delta review of commit ${f.head}; stays open.`, author: { login: "bot", __typename: "User" } };
    const passing = withGit(f.runtimeFor(open(live)));
    const done = await verifyFixerDisposition({ ...f.options, check: true }, passing.deps);
    assert.equal(done.complete, true);
    assert.equal(passing.residualPosts.length, 0);
  });
});
