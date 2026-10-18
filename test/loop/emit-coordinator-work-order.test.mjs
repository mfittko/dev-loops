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
    assert.equal(JSON.parse(result.stdout).ok, false, flag);
    assert.match(JSON.parse(result.stdout).error, /Unknown option/, flag);
  }
});

async function withInput(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "emit-coordinator-"));
  try {
    const input = path.join(dir, "resolver.json");
    await writeFile(input, JSON.stringify(resolverOutput));
    return await fn(input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("C1 --fields workOrderDigest prints only the digest", async () => {
  await withInput(async (input) => {
    const result = await runNode(["--input", input, "--repo", "o/r", "--fields", "workOrderDigest"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
  });
});

test("C19 a refused allowed file exits 1 with ok:false JSON on stdout", async () => {
  await withInput(async (input) => {
    const result = await runNode(["--input", input, "--repo", "o/r", "--allowed-file", "../x"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    const silent = await runNode(["--input", input, "--repo", "o/r", "--allowed-file", "../x", "--silent"]);
    assert.equal(silent.code, 1);
    assert.equal(silent.stdout, "");
  });
});

test("C2 --attempt accepts only positive decimal integers", async () => {
  await withInput(async (input) => {
    for (const good of ["1", "2", "10"]) {
      const result = await runNode(["--input", input, "--repo", "o/r", `--attempt=${good}`]);
      assert.equal(result.code, 0, good);
      assert.equal(JSON.parse(result.stdout).workOrder.attempt, Number(good));
    }
    for (const bad of ["", "0", "0x2", " 2", "2e0", "1.0", "1.5", "-1"]) {
      const result = await runNode(["--input", input, "--repo", "o/r", `--attempt=${bad}`]);
      assert.equal(result.code, 1, JSON.stringify(bad));
      assert.equal(JSON.parse(result.stdout).ok, false, JSON.stringify(bad));
    }
  });
});

test("a missing --input emits ok:false JSON on stdout and exits 1", async () => {
  const result = await runNode([]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
