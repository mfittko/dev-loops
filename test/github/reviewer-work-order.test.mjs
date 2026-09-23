import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { REVIEWER_WORK_ORDER_MAX_BYTES, buildAngleNamingSuffix } from "../../scripts/github/emit-fanout-dispatch.mjs";
import {
  buildGateBriefingPrefixPath,
  buildGateDiffPath,
  buildGateEmitPlanPath,
  mapGateToConfigKey,
  PRIOR_DISPOSITIONS_MAX_ENTRIES,
  PRIOR_DISPOSITIONS_MAX_FIELD_LENGTH,
  parseWriteGateContextCliArgs,
  renderBriefingVolatile,
  resolveFanoutDispatch,
  writeGateContext,
} from "../../scripts/github/write-gate-context.mjs";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { verifyDispatchPromptLayoutForHead } from "../../scripts/github/verify-dispatch-prompt-layout.mjs";

const emitCliPath = path.resolve("scripts/github/emit-fanout-dispatch.mjs");
const HEAD_SHA = "c".repeat(40);
const GATE = "pre_approval_gate";
const REPO = "o/r";
const PR = "7";
const ANGLES = ["dry", "kiss", "determinism", "state-concurrency", "contradiction-lens"];
const PR_BODY_MARKER = "PR-BODY-MARKER-UNIQUE-TEXT";
const ISSUE_BODY_MARKER = "ISSUE-BODY-MARKER-UNIQUE-TEXT";

function makeDiff(lineCount) {
  const lines = [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "index 000000000000..111111111111 100644",
    "--- a/src/a.mjs",
    "+++ b/src/a.mjs",
    `@@ -0,0 +1,${lineCount} @@`,
  ];
  for (let i = 0; i < lineCount; i += 1) lines.push(`+export const value${i} = ${i};`);
  return `${lines.join("\n")}\n`;
}

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-work-order-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeRound(repoRoot, { diffOutput = makeDiff(10), issueBody = `${ISSUE_BODY_MARKER}\n- [ ] AC one`, harness, angleScopes } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const options = parseWriteGateContextCliArgs([
    "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA,
    "--angles", JSON.stringify(ANGLES),
  ]);
  const diffPath = buildGateDiffPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA });
  Object.assign(options, {
    config,
    fanoutDispatch: resolveFanoutDispatch(config, mapGateToConfigKey(GATE), ANGLES, {}),
    prBody: `${PR_BODY_MARKER}\nSummary of the change.`,
    acceptanceCriteria: "#1",
    issueBody,
    diffOutput,
    diffPath,
    diffToWrite: { path: diffPath, text: diffOutput },
    changedFiles: ["src/a.mjs"],
    adjacentCode: { files: [{ path: "src/b.mjs", role: "importer", content: "ADJACENT-CONTENT" }], stripped: [], truncated: [], missing: [] },
    ...(harness ? { harness } : {}),
    ...(angleScopes ? { angleScopes } : {}),
  });
  return writeGateContext(options, { repoRoot });
}

function runEmit(repoRoot, env = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDECODE;
  const result = spawnSync("node", [emitCliPath, "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA], {
    cwd: repoRoot, encoding: "utf8", env: { ...baseEnv, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("work order: the emitted prompt carries no PR/issue body, diff body, or adjacent bundle, and references each by requiredReads", async () => {
  await withTmpDir(async (repoRoot) => {
    const written = await writeRound(repoRoot);
    const payload = runEmit(repoRoot);
    assert.ok(payload.units.length >= 3);
    const kinds = written.artifact.requiredReads.map((r) => r.kind);
    assert.ok(kinds.includes("evidence") && kinds.includes("diff") && kinds.includes("context"), JSON.stringify(kinds));
    const evidence = await readFile(path.join(repoRoot, written.artifact.requiredReads.find((r) => r.kind === "evidence").path), "utf8");
    assert.ok(evidence.includes(PR_BODY_MARKER) && evidence.includes(ISSUE_BODY_MARKER) && evidence.includes("diff --git a/src/a.mjs"));
    for (const unit of payload.units) {
      const prompt = await readFile(unit.promptPath, "utf8");
      assert.ok(!prompt.includes(PR_BODY_MARKER), "PR body is referenced, never inlined");
      assert.ok(!prompt.includes(ISSUE_BODY_MARKER), "issue body is referenced, never inlined");
      assert.doesNotMatch(prompt, /^diff --git /m);
      assert.doesNotMatch(prompt, /^@@ /m);
      assert.ok(!prompt.includes("ADJACENT-CONTENT") && !prompt.includes("src/b.mjs"), "adjacent bundle is referenced, never inlined");
      assert.match(prompt, /## Required reads/);
      for (const read of written.artifact.requiredReads) {
        assert.ok(prompt.includes(path.resolve(repoRoot, read.path)), `prompt names ${read.kind} at its worktree-absolute path`);
        if (read.sha256) assert.ok(prompt.includes(read.sha256), `prompt binds ${read.kind} sha256`);
      }
    }
  });
});

test("work order: prompt size is independent of diff size (small vs >=100x diff)", async () => {
  const sizes = [];
  for (const lines of [10, 2000]) {
    await withTmpDir(async (repoRoot) => {
      await writeRound(repoRoot, { diffOutput: makeDiff(lines) });
      const payload = runEmit(repoRoot);
      sizes.push(Object.fromEntries(payload.units.map((u) => [u.scope, u.promptBytes])));
    });
  }
  assert.ok(Buffer.byteLength(makeDiff(2000)) >= 100 * Buffer.byteLength(makeDiff(10)));
  for (const scope of Object.keys(sizes[0])) {
    assert.ok(Math.abs(sizes[1][scope] - sizes[0][scope]) <= 256, `${scope}: ${sizes[0][scope]} vs ${sizes[1][scope]}`);
    assert.ok(sizes[1][scope] < REVIEWER_WORK_ORDER_MAX_BYTES);
  }
});

test("work order: prompt size is independent of issue/spec body size (small vs 100x body)", async () => {
  const sizes = [];
  const small = `${ISSUE_BODY_MARKER}\n- [ ] AC one`;
  for (const body of [small, small.repeat(100)]) {
    await withTmpDir(async (repoRoot) => {
      await writeRound(repoRoot, { issueBody: body });
      const payload = runEmit(repoRoot);
      sizes.push(Object.fromEntries(payload.units.map((u) => [u.scope, u.promptBytes])));
    });
  }
  for (const scope of Object.keys(sizes[0])) {
    assert.ok(Math.abs(sizes[1][scope] - sizes[0][scope]) <= 256, `${scope}: ${sizes[0][scope]} vs ${sizes[1][scope]}`);
    assert.ok(sizes[1][scope] < REVIEWER_WORK_ORDER_MAX_BYTES);
  }
});

test("work order: schema carries target, operation, round identity, config identity, angles, reads, outputs, and execution rules; hashes match disk", async () => {
  await withTmpDir(async (repoRoot) => {
    await writeRound(repoRoot);
    const payload = runEmit(repoRoot);
    const prefixBytes = await readFile(path.join(repoRoot, buildGateBriefingPrefixPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA })));
    for (const unit of payload.units) {
      const order = unit.workOrder;
      assert.deepEqual(order.target, { repo: REPO, pr: PR });
      assert.equal(order.operation, "gate");
      assert.deepEqual(order.roundIdentity, { gate: GATE, headSha: HEAD_SHA, prefixSha256: sha256(prefixBytes) });
      assert.equal(order.headSha, HEAD_SHA);
      assert.match(order.configSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(order.assignedAngles, unit.angles);
      assert.deepEqual(order.angleInstructions, unit.angleInstructions);
      assert.deepEqual(order.outputRefs.map((ref) => path.basename(ref)), unit.angles.map((a) => `${a}.json`));
      for (const ref of order.outputRefs) assert.ok(path.isAbsolute(ref));
      assert.ok(order.executionRules.budget.maxToolCalls > 0);
      assert.ok(Array.isArray(order.executionRules.prohibited) && order.executionRules.prohibited.length > 0);
      assert.ok(order.requiredReads.length > 0);
      for (const read of order.requiredReads) {
        assert.equal(typeof read.required, "boolean");
        if (read.sha256 === undefined) continue;
        const bytes = await readFile(path.resolve(repoRoot, read.path));
        assert.equal(read.sha256, sha256(bytes), `${read.kind} sha256`);
        assert.equal(read.bytes, bytes.length, `${read.kind} bytes`);
      }
      const sections = unit.sectionBytes;
      assert.equal(sections.prefix, prefixBytes.length);
      assert.equal(sections.prefix + sections.volatile + sections.suffix, unit.promptBytes);
      assert.equal((await stat(unit.promptPath)).size, unit.promptBytes);
    }
  });
});

test("work order: siblings share the byte-identical prefix and identical shared reads, differ only in their own angle instructions", async () => {
  await withTmpDir(async (repoRoot) => {
    await writeRound(repoRoot);
    const payload = runEmit(repoRoot);
    assert.ok(payload.units.length >= 3);
    const prefix = await readFile(path.join(repoRoot, buildGateBriefingPrefixPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA })), "utf8");
    const prompts = await Promise.all(payload.units.map((u) => readFile(u.promptPath, "utf8")));
    for (const prompt of prompts) assert.ok(prompt.startsWith(prefix));
    const shared = JSON.stringify(payload.units[0].workOrder.requiredReads);
    for (const unit of payload.units) assert.equal(JSON.stringify(unit.workOrder.requiredReads), shared);
    assert.equal(new Set(payload.units.map((u) => JSON.stringify(u.angleInstructions))).size, payload.units.length);
    payload.units.forEach((unit, i) => {
      for (const sibling of payload.units) {
        if (sibling === unit) continue;
        for (const instruction of sibling.angleInstructions) {
          assert.ok(!prompts[i].includes(instruction.prompt), `${unit.scope} must not carry ${instruction.angle}'s prompt`);
          assert.ok(!prompts[i].includes(`/${instruction.angle}.json`), `${unit.scope} must not carry ${instruction.angle}'s output ref`);
        }
      }
      for (const instruction of unit.angleInstructions) assert.ok(prompts[i].includes(instruction.prompt));
    });
  });
});

test("work order: dispatch-prompt layout verifies per unit and every unit binds the same prefix hash", async () => {
  await withTmpDir(async (repoRoot) => {
    await writeRound(repoRoot);
    const payload = runEmit(repoRoot);
    const layout = await verifyDispatchPromptLayoutForHead(path.join(repoRoot, "tmp"), HEAD_SHA);
    assert.equal(layout.verified, true, JSON.stringify(layout));
    assert.equal(new Set(payload.units.map((u) => u.workOrder.roundIdentity.prefixSha256)).size, 1); // secret-scan:allow property path, not a secret
  });
});

test("work order: emission needs no primer evidence or cache telemetry", async () => {
  await withTmpDir(async (repoRoot) => {
    await writeRound(repoRoot);
    const contextDir = path.dirname(path.join(repoRoot, buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA })));
    await assert.rejects(() => stat(path.join(contextDir, `${GATE}-${HEAD_SHA}.primer-evidence.json`)), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(contextDir, `${GATE}-${HEAD_SHA}.cache-telemetry.json`)), { code: "ENOENT" });
    const payload = runEmit(repoRoot);
    assert.ok(payload.units.every((u) => u.promptBytes < REVIEWER_WORK_ORDER_MAX_BYTES));
  });
});

test("work order: Claude and Pi paths get identical prompt bytes and the same referenced evidence", async () => {
  await withTmpDir(async (repoRoot) => {
    await writeRound(repoRoot);
    const plain = runEmit(repoRoot);
    const plainPrompts = await Promise.all(plain.units.map((u) => readFile(u.promptPath)));
    const claude = runEmit(repoRoot, { CLAUDECODE: "1" });
    const claudePrompts = await Promise.all(claude.units.map((u) => readFile(u.promptPath)));
    assert.deepEqual(claudePrompts, plainPrompts);
  });
  const perHarness = [];
  for (const harness of ["pi", "claude"]) {
    await withTmpDir(async (repoRoot) => {
      const written = await writeRound(repoRoot, { harness });
      perHarness.push({ prefix: await readFile(path.join(repoRoot, written.prefixPath), "utf8").then((t) => t.replaceAll(repoRoot, "<root>")), reads: written.artifact.requiredReads });
    });
  }
  assert.equal(perHarness[0].prefix, perHarness[1].prefix);
  assert.deepEqual(perHarness[0].reads, perHarness[1].reads);
});

test("work order: a unit whose angles share a scoped variant reads the builder-hashed variant in place of the shared evidence", async () => {
  await withTmpDir(async (repoRoot) => {
    const written = await writeRound(repoRoot, { angleScopes: { dry: "docs-only", kiss: "docs-only" } });
    const recorded = written.artifact.requiredReads.find((r) => r.kind === "scoped-evidence");
    assert.equal(recorded.scope, "docs-only");
    assert.equal(recorded.path, written.artifact.briefingVariants["docs-only"]);
    assert.equal(recorded.required, false);
    assert.equal(recorded.sha256, sha256(await readFile(path.join(repoRoot, recorded.path))));
    const prefix = await readFile(path.join(repoRoot, written.prefixPath), "utf8");
    assert.ok(!prefix.includes(recorded.sha256), "the shared prefix never lists a variant");
    const payload = runEmit(repoRoot);
    const scoped = payload.units.find((u) => u.angles.includes("dry"));
    const extra = scoped.workOrder.requiredReads.filter((r) => r.kind === "scoped-evidence");
    assert.deepEqual(extra, [{ ...recorded, required: true }]);
    assert.ok(!scoped.workOrder.requiredReads.some((r) => r.kind === "evidence"), "the variant replaces the shared evidence read");
    const prompt = await readFile(scoped.promptPath, "utf8");
    assert.ok(prompt.includes(path.resolve(repoRoot, recorded.path)) && prompt.includes(recorded.sha256));
    assert.match(prompt, /REPLACES the shared `evidence` read/);
    for (const unit of payload.units.filter((u) => u !== scoped)) {
      assert.ok(!unit.workOrder.requiredReads.some((r) => r.kind === "scoped-evidence"));
      assert.ok(unit.workOrder.requiredReads.some((r) => r.kind === "evidence"));
    }
  });
});

// Every `prompt` string anywhere in the shipped defaults, longest first.
function shippedPrompts(node, out = []) {
  if (Array.isArray(node)) for (const item of node) shippedPrompts(item, out);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "prompt" && typeof value === "string") out.push(value);
      else shippedPrompts(value, out);
    }
  }
  return out.sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
}

test("work order: the worst case (maximal prior dispositions, three longest shipped prompts, scoped read) stays under the ceiling", async () => {
  await withTmpDir(async (repoRoot) => {
    const written = await writeRound(repoRoot);
    const prefixBytes = (await stat(path.join(repoRoot, written.prefixPath))).size;
    // 3-byte UTF-8 characters: the largest byte count per UTF-16 unit the char-based truncation allows.
    const wide = "中".repeat(PRIOR_DISPOSITIONS_MAX_FIELD_LENGTH + 50);
    const priorDispositions = Array.from({ length: PRIOR_DISPOSITIONS_MAX_ENTRIES + 5 }, () => ({
      fingerprint: "f".repeat(16), angle: wide, severity: wide, summary: wide, judgeRationale: wide,
    }));
    const volatileBytes = Buffer.byteLength(renderBriefingVolatile({
      gate: GATE, headSha: HEAD_SHA, loggedAt: new Date().toISOString(), validationPosture: "v".repeat(500), priorDispositions,
    }));
    const defaults = parseYaml(await readFile(path.resolve("packages/core/src/config/extension-defaults.yaml"), "utf8"));
    const longest = shippedPrompts(defaults).slice(0, 3);
    assert.equal(longest.length, 3);
    const angles = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    const suffixBytes = Buffer.byteLength(buildAngleNamingSuffix(
      { name: "n".repeat(64), angles },
      `pre-approval-gate-group-${"s".repeat(64)}`,
      angles.map((angle, i) => ({ angle, persona: "p".repeat(64), prompt: longest[i] })),
      [{ kind: "scoped-evidence", scope: "changed-files", path: path.join(repoRoot, "p".repeat(200)), sha256: "f".repeat(64), bytes: 99999999, required: true }],
    ));
    const total = prefixBytes + volatileBytes + suffixBytes;
    assert.ok(total < REVIEWER_WORK_ORDER_MAX_BYTES, `worst case ${total} bytes (prefix ${prefixBytes}, volatile ${volatileBytes}, suffix ${suffixBytes})`);
  });
});
