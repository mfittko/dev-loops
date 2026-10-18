import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runNode } from "../_helpers.mjs";
import { DISPATCH_POINTER_MAX_BYTES, buildDispatchPointer, pullReceiptPath, pullWorkOrder } from "../../scripts/github/_work-order-protocol.mjs";
import { RULE_REFERENCES } from "../../packages/core/src/loop/coordinator-work-order.mjs";
import "../../scripts/loop/emit-coordinator-work-order.mjs"; // registers the coordinator role

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
    return await fn({ dir, input, tmp: path.join(dir, "tmp") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const emit = async ({ input, tmp }, harness, entry, extra = []) => {
  const result = await runNode(script, ["--input", input, "--repo", "o/r", "--harness", harness, "--entry", entry, "--tmp-root", tmp, ...extra]);
  return { result, out: JSON.parse(result.stdout) };
};

for (const harness of ["claude", "pi"]) {
  for (const entry of ["queue", "direct"]) {
    test(`C6a ${harness} ${entry} initial and resumed dispatch carry only the pull pointer`, async () => {
      await withDirs(async (ctx) => {
        const first = (await emit(ctx, harness, entry)).out;
        const resumed = (await emit(ctx, harness, entry)).out;
        for (const out of [first, resumed]) {
          assert.equal(out.ok, true);
          assert.equal(out.dispatchPrompt, buildDispatchPointer(out));
          assert.ok(Buffer.byteLength(out.dispatchPrompt) <= DISPATCH_POINTER_MAX_BYTES);
          assert.deepEqual(out.dispatchPayload, harness === "pi"
            ? { agent: "dev-loop", task: out.dispatchPrompt }
            : { subagent_type: "dev-loop", description: "coordinator work order", prompt: out.dispatchPrompt });
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

test("C6a codex and unknown harnesses refuse with unsupported_adapter and write nothing", async () => {
  await withDirs(async (ctx) => {
    for (const harness of ["codex", "bogus"]) {
      const { result, out } = await emit(ctx, harness, "queue");
      assert.equal(result.code, 1);
      assert.equal(out.ok, false);
      assert.equal(out.refusal, "unsupported_adapter");
    }
    assert.equal(existsSync(ctx.tmp), false);
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
    const pull = await runNode(path.resolve("scripts/github/pull-work-order.mjs"), ["--ref", out.workOrderRef, "--digest", out.workOrderDigest, "--execution", out.executionIdentity, "--tmp-root", ctx.tmp]);
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
