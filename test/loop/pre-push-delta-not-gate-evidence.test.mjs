import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { consolidateGateFanin } from "../../scripts/loop/consolidate-fanin.mjs";
import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { initGitFixture } from "../_helpers.mjs";

// PRE-PUSH-DELTA-NOT-GATE-EVIDENCE: a delta result for the same head placed
// where the gate and checkpoint readers look must never count as evidence.

const HEAD = "abc1234def5678";
const BASELINE = "0123456789abcd";

function deltaResult() {
  const sequence = startDeltaSequence({
    reviewBaselineHead: BASELINE,
    actList: [{ severity: "medium", angle: "correctness", summary: "s", judgeDisposition: "act", fingerprint: "b1a52cfd23cd9144" }],
  });
  return {
    reviewBaselineHead: BASELINE,
    candidateHead: HEAD,
    headSha: HEAD,
    actSetId: sequence.actSetId,
    actionableItems: [{ ref: "b1a52cfd23cd9144", status: "resolved", evidence: ["e"] }],
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
  };
}

async function withTmp(fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-delta-evidence-")));
  try {
    await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("gate fan-in: a delta result in the findings dir fails closed and never yields a clean round", async () => {
  await withTmp(async (dir) => {
    await writeFile(path.join(dir, "scope.json"), JSON.stringify({ angle: "scope", verdict: "clean", headSha: HEAD, findings: [] }));
    const without = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD });
    assert.equal(without.overallVerdict, "clean");
    await writeFile(path.join(dir, "pre-push-delta.json"), JSON.stringify(deltaResult()));
    await assert.rejects(consolidateGateFanin({ findingsDir: dir, headSha: HEAD }), /pre-push-delta\.json/);
  });
});

test("gate fan-in: a delta result alone never counts as an angle", async () => {
  await withTmp(async (dir) => {
    await writeFile(path.join(dir, "pre-push-delta.json"), JSON.stringify(deltaResult()));
    await assert.rejects(consolidateGateFanin({ findingsDir: dir, headSha: HEAD }), /pre-push-delta\.json/);
  });
});

test("checkpoint evidence: a delta result beside the findings ledger leaves the evidence unchanged", async () => {
  const config = { gates: { requireFanoutEvidence: true, draft: { required: true }, preApproval: { required: true } } };
  const ledgerRel = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
  const evidence = {
    currentHeadSha: HEAD,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD, sizeOutcome: "pass", sizeTouchesT1: false },
  };
  const probe = async (repo) => {
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: { visible: false },
      preApprovalGateMarker: { visible: true, headSha: HEAD, executionMode: "fanout_fanin" },
      config, cwd: repo,
    });
    return { enforcement, check: buildPreMergeGateCheck(evidence, 0, null, enforcement) };
  };
  await withTmp(async (repo) => {
    initGitFixture(repo);
    const ledgerPath = path.join(repo, ledgerRel);
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // A ledger with an open act item: merge is refused until the gate re-runs.
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "findings_present", overallVerdict: "findings_present", executionMode: "fanout_fanin",
      findings: [{ severity: "medium", angle: "correctness", summary: "retry loop never backs off", judgeDisposition: "act" }],
    }));
    const before = await probe(repo);
    assert.equal(before.check.ok, false);

    // The same-head delta result claims locally_clear; the checkpoint reader must ignore it.
    await writeFile(path.join(path.dirname(ledgerPath), "pre-push-delta.json"), JSON.stringify(deltaResult()));
    const gateJudgeDir = path.join(repo, "tmp", "gate-judge", "owner-repo", "pr-42", `pre_approval_gate-${HEAD}`);
    await mkdir(gateJudgeDir, { recursive: true });
    await writeFile(path.join(gateJudgeDir, "pre-push-delta.json"), JSON.stringify(deltaResult()));
    const after = await probe(repo);
    assert.deepEqual(after, before);
  });
});
