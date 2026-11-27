import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "../src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, STATE } from "../src/loop/copilot-loop-state.mjs";

// ADR 0208: after the cap round's fixer pass has landed and its delta has cleared, coordination never returns run_draft_gate.
const head = "abc123456789";
const marker = (verdict) => ({ visible: true, headSha: "abc1234", verdict, contractComplete: true });
const draftAt = (overrides = {}) => evaluatePrGateCoordination({
  pr: 10, currentHeadSha: head, prDraft: true, lifecycleState: STATE.PR_DRAFT, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
  draftGate: marker("findings_present"), draftGateMarker: marker("findings_present"), unresolvedGateThreadCount: 0, ...overrides,
});

test("a ready PR with a fixed cap round and a stale blocked draft marker opens pre_approval_gate, never reconcile_draft_gate", () => {
  const ready = (overrides = {}) => evaluatePrGateCoordination({
    pr: 10, currentHeadSha: "fedcba987654", prDraft: false, lifecycleState: STATE.READY_TO_REREQUEST_REVIEW, loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true, ciStatus: "success", draftGate: marker("blocked"), draftGateMarker: marker("blocked"),
    preApprovalGate: { visible: false }, preApprovalGateMarker: { visible: false }, ...overrides,
  });
  assert.equal(ready({ draftCapRoundFixed: true }).nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.equal(ready({ draftCapRoundFixed: false }).nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE, "without the proof the evidence guard still reconciles");
});

// Issue 3443 AC2 (review): the ready-PR report_blocked reason carries the same detail, so a revert to the bare CAP_ROUND_REFUSAL text drops the uncovered ref and fails here.
test("a ready PR with items_do_not_cover names the uncovered act ref and the records, or the unresolved history", () => {
  const ready = (overrides = {}) => evaluatePrGateCoordination({
    pr: 10, repo: "o/r", currentHeadSha: "fedcba987654", prDraft: false, lifecycleState: STATE.READY_TO_REREQUEST_REVIEW, loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true, ciStatus: "success", draftGate: marker("blocked"), draftGateMarker: marker("blocked"),
    preApprovalGate: { visible: false }, preApprovalGateMarker: { visible: false }, draftCapRoundFixed: false, draftCapRoundFailure: "items_do_not_cover", ...overrides,
  });
  const draftCapRoundDetail = { uncovered: ["ref-escalated"], records: [{ baseline: "a".repeat(40), candidate: "b".repeat(40), refs: ["ref-one"] }] };
  const named = ready({ draftCapRoundDetail });
  assert.equal(named.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(named.reason, /Uncovered act refs: ref-escalated\. Records on the chain: aaaaaaa\.\.bbbbbbb \[ref-one\]\./);
  assert.ok(!ready().reason.includes("Uncovered act refs"), "no detail, no suffix");
  const unresolved = ready({ draftCapRoundDetail: { ...draftCapRoundDetail, unresolved: ["c".repeat(40)] } });
  assert.match(unresolved.reason, new RegExp(`git fetch origin ${"c".repeat(40)}`, "u"));
  assert.ok(!unresolved.reason.includes("Uncovered act refs"), "an unreadable history proves no ref uncovered");
});

test("no source file contains the catch-all 'legacy unsealed delta record' refusal text", () => {
  const grep = spawnSync("git", ["grep", "-l", "legacy unsealed delta record", "--", "*.mjs", "*.js", "*.ts"], { encoding: "utf8", cwd: fileURLToPath(new URL("../../..", import.meta.url)) });
  assert.ok(grep.status === 0 || grep.status === 1, "git grep ran"); // status 1 = no hits
  const hits = grep.stdout.split("\n").filter((file) => file && !file.includes("cap-round-fixed-coordination.test.mjs"));
  assert.deepEqual(hits, []);
});

// The unposted clean cap round (a local ledger only): a ready PR is never final_approval_ready on it, and the one exit is the ledger-derived post.
test("a ready PR whose clean cap-round verdict is unposted reports blocked with the sealed-ledger post as its remedy", () => {
  const result = evaluatePrGateCoordination({
    pr: 10, repo: "o/r", currentHeadSha: "fedcba987654", prDraft: false, lifecycleState: STATE.READY_TO_REREQUEST_REVIEW, loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true, ciStatus: "success", draftGate: marker("findings_present"), draftGateMarker: marker("findings_present"),
    preApprovalGate: { visible: true, headSha: "fedcba987654", verdict: "clean", contractComplete: true }, preApprovalGateMarker: { visible: true, headSha: "fedcba987654", verdict: "clean", contractComplete: true },
    draftCapRoundFixed: false, draftCapRoundFailure: "clean_cap_verdict_unposted",
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(result.draftGateAlreadySatisfied, false);
  assert.equal(result.agentRemedy.command, "dev-loops gate upsert-verdict --repo o/r --pr 10 --gate draft_gate --post-sealed-cap-round");
});

