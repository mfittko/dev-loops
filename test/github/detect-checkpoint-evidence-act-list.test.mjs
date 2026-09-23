import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { initGitFixture } from "../_helpers.mjs";

// Merge's evidence probe refuses a current-head pre_approval_gate ledger whose
// judge act list is not empty.

const HEAD = "abc1234def5678";
const CONFIG = { gates: { requireFanoutEvidence: true, draft: { required: true }, preApproval: { required: true } } };
const PA_MARKER = { visible: true, headSha: HEAD, executionMode: "fanout_fanin" };
const NO_DRAFT_MARKER = { visible: false };

function cleanEvidenceFor(headSha) {
  return {
    currentHeadSha: headSha,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha, sizeOutcome: "pass", sizeTouchesT1: false },
  };
}

const ACT_ITEM = { severity: "medium", angle: "correctness", summary: "retry loop never backs off", judgeDisposition: "act" };
const REJECTED_ITEM = { severity: "low", angle: "docs", summary: "reword the heading", judgeDisposition: "reject" };

function actListEnforcement(openActItems) {
  return {
    required: true,
    gates: [{ name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerExists: true, ledgerPath: "tmp/ledger.json", openActItems, provenance: null, mandatoryAngles: [], anglePool: null }],
  };
}

test("buildPreMergeGateCheck refuses a non-empty act list and names the items", () => {
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, actListEnforcement([ACT_ITEM]));
  assert.equal(check.ok, false);
  assert.deepEqual(check.failures, ["pre_approval_gate: judge act list is not empty (1 open act item(s): [medium] retry loop never backs off)"]);
});

test("buildPreMergeGateCheck passes once the act list is empty", () => {
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, actListEnforcement([]));
  assert.equal(check.ok, true, JSON.stringify(check.failures));
});

test("skipFanoutLedgerCheck skips the act-list check like the other ledger checks", () => {
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, actListEnforcement([ACT_ITEM]), { skipFanoutLedgerCheck: true });
  assert.equal(check.ok, true, JSON.stringify(check.failures));
});

async function withLedgerRepo(findings, fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-act-list-")));
  try {
    const repo = path.join(base, "a");
    await mkdir(repo, { recursive: true });
    initGitFixture(repo);
    const ledgerPath = path.join(repo, buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" }));
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, JSON.stringify({ repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", overallVerdict: "clean", findings }), "utf8");
    await fn(repo);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("buildFanoutEnforcement reads the current-head pre_approval_gate act list from the ledger", async () => {
  await withLedgerRepo([ACT_ITEM, REJECTED_ITEM], async (repo) => {
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER, config: CONFIG, cwd: repo,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.deepEqual(pa.openActItems.map((f) => f.summary), ["retry loop never backs off"]);
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, false);
    assert.ok(check.failures.some((f) => f.includes("judge act list is not empty") && f.includes("retry loop never backs off")), JSON.stringify(check.failures));
  });
});

test("buildFanoutEnforcement reports an empty act list when every finding is rejected or deferred", async () => {
  await withLedgerRepo([REJECTED_ITEM, { ...ACT_ITEM, judgeDisposition: "defer" }], async (repo) => {
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER, config: CONFIG, cwd: repo,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.deepEqual(pa.openActItems, []);
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.ok(!check.failures.some((f) => f.includes("judge act list")), JSON.stringify(check.failures));
  });
});
