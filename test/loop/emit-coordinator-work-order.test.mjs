import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runNode as runNodeHelper } from "../_helpers.mjs";

const runNode = (args) => runNodeHelper(path.resolve("scripts/loop/emit-coordinator-work-order.mjs"), args);
const resolverOutput = {
  ok: true,
  bundle: {
    bundleKind: "resolved",
    activeArtifact: { kind: "issue", issue: 42, pr: null, branch: null, phase: null },
    selectedStrategy: "issue_intake",
    executionMode: "bounded_handoff",
    nextAction: "Normalize the issue, confirm scope",
    requiredReads: ["skills/docs/public-dev-loop-contract.md"],
    routeKind: "route",
    selectedGate: "issue_intake",
  },
};

test("C1 C19 emit-coordinator-work-order prints the envelope-derived order with the changes fragment path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "emit-coordinator-"));
  try {
    const input = path.join(dir, "resolver.json");
    await writeFile(input, JSON.stringify(resolverOutput));
    const result = await runNode(["--input", input, "--repo", "o/r", "--allowed-file", "src/a.mjs"]);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.workOrder.handoff.nextAction, resolverOutput.bundle.nextAction);
    assert.deepEqual(out.workOrder.allowedFiles, ["changes/42-*.md", "src/a.mjs"]);
    assert.match(out.workOrderDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C1 emit-coordinator-work-order rejects brief, overrides and payload flags", async () => {
  for (const flag of ["--brief", "--overrides", "--payload", "--summary-file"]) {
    const result = await runNode(["--input", "x.json", flag, "text"]);
    assert.notEqual(result.code, 0, flag);
  }
});
