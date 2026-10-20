import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { runNode } from "../_helpers.mjs";
import { DISPATCH_POINTER_MAX_BYTES, buildDispatchPointer, pullReceiptPath, pullWorkOrder } from "../../scripts/github/_work-order-protocol.mjs";
import { RULE_REFERENCES } from "../../packages/core/src/loop/coordinator-work-order.mjs";
import { buildCoordinatorDispatchPayload, renderCoordinatorWorkOrder } from "../../scripts/loop/emit-coordinator-work-order.mjs";
import { workOrderDigest } from "../../packages/core/src/loop/work-order-digest.mjs";
import { resolveAuthoritativeStartupResumeBundle } from "../../packages/core/src/loop/public-dev-loop-routing.mjs";
import { resolveWorktreePath } from "../../packages/core/src/loop/handoff-envelope.mjs";

const script = path.resolve("scripts/loop/emit-coordinator-work-order.mjs");
const resolverOutput = { ok: true, bundle: {
  bundleKind: "resolved", activeArtifact: { kind: "issue", issue: 42, pr: null, branch: null, phase: null },
  selectedStrategy: "issue_intake", executionMode: "bounded_handoff", nextAction: "Normalize the issue",
  requiredReads: ["skills/docs/public-dev-loop-contract.md"], routeKind: "route", selectedGate: "issue_intake",
} };

async function withDirs(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coordinator-dispatch-"));
  try {
    const input = path.join(dir, "resolver.json");
    await writeFile(input, JSON.stringify(resolverOutput));
    execFileSync("git", ["init", "-q", dir]); // the dir is a checkout, so its tmp/ is a listed ledger root
    return await fn({ dir, input, tmp: path.join(dir, "tmp") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const emit = async ({ input, tmp, dir }, harness, entry, extra = []) => {
  const result = await runNode(script, ["--input", input, "--repo", "o/r", "--harness", harness, "--entry", entry, "--tmp-root", tmp, ...extra], { cwd: dir });
  return { result, out: JSON.parse(result.stdout) };
};

test("tracker-local startup survives canonical coordinator emission for every harness", async () => {
  await withDirs(async (ctx) => {
    for (const issue of [2335, 2508]) {
      const bundle = resolveAuthoritativeStartupResumeBundle({
        targetPreference: "prefer_local",
        currentState: {
          target: { kind: "issue", issue }, ownership: "copilot", nextActor: "copilot",
          status: "active", authorization: "needs_confirmation",
        },
        issueLinkageResolution: "resolved_no_open_pr", issueReadiness: "ready",
        issueAssignmentState: "assigned_to_copilot", artifactState: "not_applicable", loopState: "awaiting_triage",
      });
      assert.equal(bundle.bundleKind, "resolved");
      const startup = JSON.stringify({ ok: true, bundle });
      await writeFile(ctx.input, startup);
      for (const harness of ["pi", "claude", "codex"]) {
        const { result, out } = await emit(ctx, harness, "direct");
        assert.equal(result.code, 0, result.stderr);
        const { workOrder } = JSON.parse(await readFile(out.planPath, "utf8"));
        assert.equal(workOrder.handoff.cwd, resolveWorktreePath({ repoRoot: await realpath(ctx.dir), kind: "issue", number: issue }));
        assert.equal(workOrder.handoff.target.kind, "local_phase");
        assert.equal(workOrder.handoff.target.phase, `issue-${issue}`);
        assert.equal(workOrder.handoff.nextAction, bundle.nextAction);
        assert.deepEqual(workOrder.handoff.requiredReads, bundle.requiredReads ?? []);
        assert.equal(out.dispatchPrompt, buildDispatchPointer(out));
        assert.equal(await readFile(ctx.input, "utf8"), startup);
      }
    }
  });
});

for (const harness of ["claude", "pi", "codex"]) {
  for (const entry of ["queue", "direct"]) {
    test(`C6a ${harness} ${entry} resumed dispatch carries only the pull pointer`, async () => {
      await withDirs(async (ctx) => {
        const first = (await emit(ctx, harness, entry)).out;
        const resumed = (await emit(ctx, harness, entry)).out;
        for (const out of [first, resumed]) {
          assert.equal(out.ok, true);
          assert.equal(out.dispatchPrompt, buildDispatchPointer(out));
          assert.ok(Buffer.byteLength(out.dispatchPrompt) <= DISPATCH_POINTER_MAX_BYTES);
          assert.deepEqual(out.dispatchPayload, harness === "pi"
            ? { agent: "dev-loop", task: out.dispatchPrompt }
            : harness === "codex"
              ? { task_name: `coordinator_${out.executionIdentity.replaceAll("-", "_")}`, message: out.dispatchPrompt, fork_turns: "none" }
              : { subagent_type: "dev-loops:dev-loop", description: "coordinator work order", prompt: out.dispatchPrompt });
        }
        assert.match(first.workOrderRef, new RegExp(`^coordinator:o/r#42:${entry}:[0-9a-f]{12}$`));
        assert.match(first.executionIdentity, /^c\d+-[0-9a-f]{8}$/);
        assert.equal(resumed.workOrderRef, first.workOrderRef);
        assert.equal(resumed.workOrderDigest, first.workOrderDigest);
        assert.notEqual(resumed.executionIdentity, first.executionIdentity);
        const scoped = (await emit(ctx, harness, entry, ["--allowed-file", "src/a.mjs"])).out;
        assert.notEqual(scoped.workOrderDigest, first.workOrderDigest);
        assert.notEqual(scoped.workOrderRef, first.workOrderRef);
      });
    });
  }
}

test("C6a unknown and prototype harnesses refuse before input consumption and write nothing", async () => {
  await withDirs(async (ctx) => {
    for (const harness of ["bogus", "constructor", "__proto__", "toString"]) {
      const { result, out } = await emit({ ...ctx, input: path.join(ctx.dir, "missing.json") }, harness, "queue");
      assert.equal(result.code, 1);
      assert.equal(out.ok, false);
      assert.equal(out.refusal, "unsupported_adapter");
    }
    assert.equal(existsSync(ctx.tmp), false);
  });
});

test("Codex task identities validate exactly and deterministic rebuilds keep the same pointer", () => {
  const input = { harness: "codex", executionIdentity: "c123-abcdef12", dispatchPrompt: "pointer" };
  assert.deepEqual(buildCoordinatorDispatchPayload(input), { task_name: "coordinator_c123_abcdef12", message: "pointer", fork_turns: "none" });
  assert.deepEqual(buildCoordinatorDispatchPayload(input), buildCoordinatorDispatchPayload(input));
  for (const executionIdentity of [undefined, null, 123, "", "c1-ABCDEF12", "c1-abcdef12\n", " c1-abcdef12", "c1-abcdef12/extra", "c-abcdef12", "c1-abcdef1g"]) {
    assert.throws(() => buildCoordinatorDispatchPayload({ ...input, executionIdentity }), /execution identity/);
  }
});

test("Codex bootstrap pins emitting source bytes and keeps canonical authority and old renderer bytes", async () => {
  await withDirs(async (ctx) => {
    const codex = (await emit(ctx, "codex", "direct")).out;
    assert.equal(codex.ok, true);
    const plan = JSON.parse(await readFile(codex.planPath, "utf8"));
    const plain = (await emit(ctx, "pi", "direct")).out;
    const { codexBootstrap: bootstrap, ...order } = plan.workOrder;
    assert.deepEqual(order, JSON.parse(await readFile(plain.planPath, "utf8")).workOrder);
    assert.equal(workOrderDigest(plan.workOrder), codex.workOrderDigest);
    assert.equal(bootstrap.version, 1);
    assert.equal(bootstrap.toolchainRoot, path.resolve("."));
    assert.deepEqual(bootstrap.contracts.map((contract) => contract.path), ["agents/dev-loop.agent.md", "skills/docs/copilot-loop-operations.md", "skills/docs/main-agent-contract.md"]);
    for (const contract of bootstrap.contracts) {
      assert.equal(contract.absolutePath, path.join(bootstrap.toolchainRoot, contract.path));
      assert.equal(contract.required, true);
      assert.equal(contract.digest, createHash("sha256").update(await readFile(contract.absolutePath)).digest("hex"));
      assert.equal(Object.hasOwn(contract, "sha256"), false);
    }
    assert.equal(bootstrap.cwd.processCwd, await realpath(ctx.dir));
    assert.equal(bootstrap.cwd.repositoryRoot, await realpath(ctx.dir));
    assert.equal(typeof bootstrap.cwd.branch, "string");
    assert.match(bootstrap.instructions.join("\n"), /shasum.*hash.*fully read.*requiredReads.*actual cwd.*stop/s);
    // Main/base and candidate renderers must agree: native spawn inherits the parent's cwd.
    const originalRenderer = (workOrder) => `# Coordinator work order (ADR 0106)\n\nTreat the handoff below as the complete envelope for ${workOrder.target.repo}. Follow its nextAction, stopRules, requiredReads and sanctionedCommands; ruleReferences name the rule owners.\n\n\`\`\`json\n${JSON.stringify(workOrder, null, 2)}\n\`\`\`\n`;
    assert.equal(originalRenderer(plan.workOrder), renderCoordinatorWorkOrder(plan.workOrder));
    assert.equal(await readFile(path.join(path.dirname(codex.planPath), "order.md"), "utf8"), originalRenderer(plan.workOrder));
  });
});

test("Codex bootstrap uses the supplied cwd despite inherited Git directory overrides", async () => {
  await withDirs(async (ctx) => withDirs(async (foreign) => {
    execFileSync("git", ["-C", ctx.dir, "symbolic-ref", "HEAD", "refs/heads/issue-2843"]);
    execFileSync("git", ["-C", foreign.dir, "symbolic-ref", "HEAD", "refs/heads/foreign-main"]);
    const result = await runNode(script, ["--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "direct", "--tmp-root", ctx.tmp], {
      cwd: ctx.dir,
      env: { ...process.env, GIT_DIR: path.join(foreign.dir, ".git"), GIT_WORK_TREE: foreign.dir },
    });
    assert.equal(result.code, 0, result.stderr);
    const { planPath } = JSON.parse(result.stdout);
    const { workOrder } = JSON.parse(await readFile(planPath, "utf8"));
    assert.deepEqual(workOrder.codexBootstrap.cwd, { processCwd: await realpath(ctx.dir), repositoryRoot: await realpath(ctx.dir), branch: "issue-2843" });
  }));
});

test("Codex bootstrap refuses missing, empty, directory and redirected emitting contracts before writing", async () => {
  await withDirs(async (ctx) => {
    const toolchain = path.join(ctx.dir, "toolchain");
    const loop = path.join(toolchain, "scripts/loop");
    await mkdir(loop, { recursive: true });
    await copyFile(script, path.join(loop, path.basename(script)));
    for (const relative of ["scripts/_core-helpers.mjs", "scripts/lib", "scripts/github", "scripts/loop/_repo-root-resolver.mjs", "scripts/loop/build-handoff-envelope.mjs", "node_modules"]) {
      await symlink(path.resolve(relative), path.join(toolchain, relative));
    }
    const args = ["--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "direct"];
    const contract = path.join(toolchain, "agents/dev-loop.agent.md");
    await mkdir(path.dirname(contract), { recursive: true });
    for (const state of ["missing", "empty", "directory", "symlink"]) {
      if (state === "empty") await writeFile(contract, "");
      if (state === "directory") await mkdir(contract);
      if (state === "symlink") await symlink(path.resolve("agents/dev-loop.agent.md"), contract);
      const result = await runNode(path.join(loop, path.basename(script)), args, { cwd: ctx.dir });
      assert.equal(result.code, 1, state);
      assert.match(JSON.parse(result.stdout).error, /ENOENT|empty|regular emitting-toolchain file/, state);
      assert.equal(existsSync(ctx.tmp), false, state);
      await rm(contract, { recursive: true, force: true });
    }
  });
});

test("Codex contract-only changes get a new reference and preserve the original materialization", async () => {
  await withDirs(async (ctx) => {
    const toolchain = path.join(ctx.dir, "toolchain");
    const loop = path.join(toolchain, "scripts/loop");
    await mkdir(loop, { recursive: true });
    const isolatedScript = path.join(loop, path.basename(script));
    await copyFile(script, isolatedScript);
    for (const relative of ["scripts/_core-helpers.mjs", "scripts/lib", "scripts/github", "scripts/loop/_repo-root-resolver.mjs", "scripts/loop/build-handoff-envelope.mjs", "node_modules"]) {
      await symlink(path.resolve(relative), path.join(toolchain, relative));
    }
    for (const relative of ["agents/dev-loop.agent.md", "skills/docs/copilot-loop-operations.md", "skills/docs/main-agent-contract.md"]) {
      await mkdir(path.dirname(path.join(toolchain, relative)), { recursive: true });
      await copyFile(path.resolve(relative), path.join(toolchain, relative));
    }
    const args = ["--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "direct", "--tmp-root", ctx.tmp];
    const firstResult = await runNode(isolatedScript, args, { cwd: ctx.dir });
    assert.equal(firstResult.code, 0, firstResult.stderr);
    const first = JSON.parse(firstResult.stdout);
    const originalPlan = await readFile(first.planPath, "utf8");
    const plan = JSON.parse(originalPlan);
    const originalOrder = await readFile(plan.promptPath, "utf8");
    const contract = plan.workOrder.codexBootstrap.contracts[0];
    await writeFile(contract.absolutePath, `${await readFile(contract.absolutePath, "utf8")}\nChanged bootstrap contract.\n`);
    const changedDigest = createHash("sha256").update(await readFile(contract.absolutePath)).digest("hex");
    const secondResult = await runNode(isolatedScript, args, { cwd: ctx.dir });
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const second = JSON.parse(secondResult.stdout);
    assert.notEqual(second.workOrderDigest, first.workOrderDigest);
    assert.notEqual(second.workOrderRef, first.workOrderRef);
    assert.notEqual(second.planPath, first.planPath);
    assert.equal(JSON.parse(await readFile(second.planPath, "utf8")).workOrder.codexBootstrap.contracts[0].digest, changedDigest);
    assert.equal(await readFile(first.planPath, "utf8"), originalPlan);
    assert.equal(await readFile(plan.promptPath, "utf8"), originalOrder);
    assert.equal((await pullWorkOrder({ ref: first.workOrderRef, digest: first.workOrderDigest, execution: first.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir })).workOrderText, originalOrder);
    // Changing the materialized pin to bless different bytes cannot reuse the old semantic authority.
    plan.workOrder.codexBootstrap.contracts[0].digest = changedDigest;
    await writeFile(first.planPath, JSON.stringify(plan));
    await writeFile(plan.promptPath, renderCoordinatorWorkOrder(plan.workOrder));
    await assert.rejects(pullWorkOrder({ ref: first.workOrderRef, digest: first.workOrderDigest, execution: first.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir }), { refusal: "semantic_identity_mismatch" });
  });
});

test("Codex materialization authenticates bootstrap metadata and rejects wrong execution", async () => {
  await withDirs(async (ctx) => {
    const out = (await emit(ctx, "codex", "queue")).out;
    const pull = { ref: out.workOrderRef, digest: out.workOrderDigest, execution: out.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir };
    const receipt = await pullWorkOrder(pull);
    assert.equal(JSON.parse(await readFile(receipt.receiptPath, "utf8")).role, "coordinator");
    await assert.rejects(pullWorkOrder({ ...pull, execution: "c1-deadbeef" }), { refusal: "dispatch_identity_mismatch" });
    const plan = JSON.parse(await readFile(out.planPath, "utf8"));
    plan.workOrder.codexBootstrap.contracts[0].absolutePath = path.join(ctx.dir, "different-contract.md");
    assert.equal(workOrderDigest(plan.workOrder), out.workOrderDigest, "absolute path is local material");
    await writeFile(out.planPath, JSON.stringify(plan));
    await assert.rejects(pullWorkOrder(pull), { refusal: "local_materialization_integrity_failure" });
  });
});

test("source-checkout Claude payload and Pi bytes stay exact with no Codex bootstrap", async () => {
  const pointer = "unchanged pointer";
  assert.deepEqual(buildCoordinatorDispatchPayload({ harness: "claude", dispatchPrompt: pointer, cwd: path.resolve(".") }), { subagent_type: "dev-loop", description: "coordinator work order", prompt: pointer });
  assert.deepEqual(buildCoordinatorDispatchPayload({ harness: "pi", dispatchPrompt: pointer }), { agent: "dev-loop", task: pointer });
});

test("Codex success selectors and refusal silent semantics remain canonical", async () => {
  await withDirs(async (ctx) => {
    const fields = await runNode(script, ["--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "direct", "--fields", "executionIdentity"], { cwd: ctx.dir });
    assert.equal(fields.code, 0, fields.stderr);
    assert.match(fields.stdout.trim(), /^c\d+-[0-9a-f]{8}$/);
    const bad = await runNode(script, ["--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "direct", "--fields", "dispatchPayload"], { cwd: ctx.dir });
    assert.equal(bad.code, 2);
    const refused = await runNode(script, ["--input", "missing", "--harness", "constructor", "--entry", "direct", "--silent"], { cwd: ctx.dir });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
  });
});

test("C6a a coordinator pull prints the exact materialized order, writes a receipt and refuses a wrong digest", async () => {
  await withDirs(async (ctx) => {
    const out = (await emit(ctx, "claude", "queue")).out;
    const pull = { ref: out.workOrderRef, digest: out.workOrderDigest, execution: out.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir };
    const { workOrderText, receiptPath } = await pullWorkOrder(pull);
    assert.equal(workOrderText, await readFile(path.join(path.dirname(out.planPath), "order.md"), "utf8"));
    assert.match(workOrderText, /"nextAction": "Normalize the issue"/);
    assert.equal(receiptPath, pullReceiptPath(ctx.dir, out.workOrderRef));
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).role, "coordinator");
    // The short pull resolves the same unit through the execution index.
    assert.equal((await pullWorkOrder({ execution: out.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir })).workOrderText, workOrderText);
    await assert.rejects(pullWorkOrder({ ...pull, digest: `sha256:${"0".repeat(64)}` }), { refusal: "dispatch_reference_mismatch" });
  });
});

test("C6a the pull-work-order CLI registers the coordinator role and prints the materialized order", async () => {
  await withDirs(async (ctx) => {
    const out = (await emit(ctx, "claude", "queue")).out;
    const pull = await runNode(path.resolve("scripts/github/pull-work-order.mjs"), ["--ref", out.workOrderRef, "--digest", out.workOrderDigest, "--execution", out.executionIdentity, "--tmp-root", ctx.tmp], { cwd: ctx.dir });
    assert.equal(pull.code, 0, pull.stderr);
    assert.equal(pull.stdout, await readFile(path.join(path.dirname(out.planPath), "order.md"), "utf8"));
  });
});

test("C9 every cited rule owner exists as a rule marker in its document", () => {
  const cited = [...RULE_REFERENCES.operationalRules, ...RULE_REFERENCES.adrCandidateRevalidation, ...RULE_REFERENCES.guardFailure.rules];
  for (const ref of cited) {
    const [doc, rule] = ref.split("#");
    assert.ok(readFileSync(doc, "utf8").includes(`<!-- rule: ${rule} -->`), ref);
  }
  assert.equal(RULE_REFERENCES.guardFailure.onFailure, "stop_and_report");
});

test("C6a a --tmp-root outside the listed checkouts refuses, since the pointer cannot reach it", async () => {
  await withDirs(async (ctx) => {
    const other = await mkdtemp(path.join(os.tmpdir(), "coordinator-elsewhere-"));
    try {
      const { result, out } = await emit({ ...ctx, tmp: other }, "claude", "queue");
      assert.equal(result.code, 1);
      assert.match(out.error, /not a checkout's tmp root/);
      assert.equal(existsSync(path.join(other, "coordinator-work-orders")), false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

test("C6a a plan that lost its workOrder refuses with the integrity refusal, not a TypeError", async () => {
  await withDirs(async (ctx) => {
    const out = (await emit(ctx, "claude", "queue")).out;
    const plan = JSON.parse(readFileSync(out.planPath, "utf8"));
    delete plan.workOrder;
    await writeFile(out.planPath, JSON.stringify(plan));
    await assert.rejects(pullWorkOrder({ ref: out.workOrderRef, digest: out.workOrderDigest, execution: out.executionIdentity, tmpRoots: [ctx.tmp], receiptTmpRoot: ctx.dir }), { refusal: "local_materialization_integrity_failure" });
  });
});

test("C6a the exact Codex alias pointer pulls its order with no --tmp-root added", async () => {
  await withDirs(async (ctx) => {
    const result = await runNode(path.resolve("cli/index.mjs"), ["loop", "coordinator-work-order", "--input", ctx.input, "--repo", "o/r", "--harness", "codex", "--entry", "queue"], { cwd: ctx.dir });
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    const command = /`dev-loops-run (scripts\/github\/pull-work-order\.mjs [^`]+)`/.exec(out.dispatchPrompt)[1].split(" ");
    assert.equal(command.includes("--tmp-root"), false);
    const pull = await runNode(path.resolve(command[0]), command.slice(1), { cwd: ctx.dir });
    assert.equal(pull.code, 0, pull.stderr);
    assert.equal(pull.stdout, await readFile(path.join(path.dirname(out.planPath), "order.md"), "utf8"));
  });
});

test("C6a the subagent dev-loop contract row pins resumed entries, the startup-output path and no loop startup", () => {
  const row = readFileSync(path.resolve("skills/docs/main-agent-contract.md"), "utf8").split("\n").find((l) => l.startsWith("| `subagent dev-loop`"));
  assert.ok(row, "row present");
  assert.match(row, /resumed queue and direct entries/);
  assert.match(row, /startup-output path/);
  assert.match(row, /never runs `loop startup`/);
  assert.match(row, /Initial entries dispatch per the Dev-loop startup rule until #2483 slice 5/);
});

test("C6b the dev-loop agent reports the startup-output path in its hand-back", () => {
  const agent = readFileSync(path.resolve("agents/dev-loop.agent.md"), "utf8");
  assert.match(agent, /report that startup-output path in your hand-back/);
});
