import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergePr } from "../../scripts/github/merge-pr.mjs";
import { buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";

// Merge refuses a current-head pre_approval_gate ledger whose judge act list
// is not empty: the evidence probe's real buildPreMergeGateCheck names the
// open act items, and merge-pr surfaces them through gate_evidence.

const HEAD = "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const MERGE_COMMIT = "aaaa1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const ACT_ITEM = { severity: "medium", angle: "correctness", summary: "retry loop never backs off", judgeDisposition: "act" };

function probeWithActList(openActItems) {
  const check = buildPreMergeGateCheck(
    {
      currentHeadSha: HEAD,
      draftGate: { visible: true, verdict: "clean" },
      preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD, sizeOutcome: "pass", sizeTouchesT1: false },
    },
    0,
    null,
    { required: false, gates: [], actList: { ledgerPath: "tmp/ledger.json", readable: true, unjudged: null, open: openActItems.length > 0 ? { path: "tmp/ledger.json", items: openActItems } : null } },
  );
  return async () => ({ ok: check.ok, sizeOutcome: "pass", touchesT1: false, currentHeadSha: HEAD, failures: check.failures });
}

function makeRuntime(detectEvidence) {
  const calls = { runChild: [] };
  const view = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    title: "fix: act list drives the review verdict",
    headRefOid: HEAD,
    url: "https://github.com/mfittko/dev-loops/pull/5",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  return {
    calls,
    runtime: {
      env: { GH_TOKEN: "t" },
      ghJson: async (args) => {
        if (args.join(" ").includes("/pulls/") || args.join(" ").includes("/issues/")) return [];
        if (args.includes("mergeCommit,state")) return { mergeCommit: { oid: MERGE_COMMIT }, state: "MERGED" };
        return view;
      },
      runChild: async (cmd, args, env) => { calls.runChild.push({ cmd, args, env }); return { stdout: "", stderr: "", code: 0 }; },
      detectEvidence,
      loadConfig: async () => ({ config: { autonomy: { humanMergeOnly: false } }, errors: [] }),
      cwd: process.cwd(),
    },
  };
}

const OPTIONS = { repo: "mfittko/dev-loops", pr: 5, humanApprovedBy: "mfittko", method: "squash", stableRelease: false, standingAuthorization: true };

test("merge refuses a current-head pre_approval_gate ledger with open act items and names them", async () => {
  const { runtime, calls } = makeRuntime(probeWithActList([ACT_ITEM]));
  let threw = null;
  try { await mergePr(OPTIONS, runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a non-empty act list must refuse");
  const gateEvidence = threw.mergePrFailure.failures.find((f) => f.precondition === "gate_evidence");
  assert.ok(gateEvidence, JSON.stringify(threw.mergePrFailure.failures));
  assert.match(threw.message, /judge act list is not empty in tmp\/ledger\.json \(1 open act item\(s\): \[medium\] retry loop never backs off\)/);
  assert.equal(calls.runChild.length, 0, "no merge with open act items");
});

test("merge passes gate_evidence once the act list is empty", async () => {
  const { runtime, calls } = makeRuntime(probeWithActList([]));
  const result = await mergePr(OPTIONS, runtime);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(calls.runChild.length, 1);
});
