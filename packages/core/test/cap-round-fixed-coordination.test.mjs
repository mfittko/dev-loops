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

test("a fixed cap round returns mark_ready_for_review, and never run_draft_gate", () => {
  for (const verdict of ["findings_present", "blocked"]) {
    const fixed = draftAt({ draftCapRoundFixed: true, draftGate: marker(verdict), draftGateMarker: marker(verdict) });
    assert.equal(fixed.nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW, verdict);
    assert.ok(!fixed.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
    assert.ok(!fixed.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE), verdict);
    assert.ok(fixed.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE), verdict);
  }
  assert.equal(draftAt({ draftCapRoundFixed: false }).nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE, "without the cap-round-fixed proof draft_gate still runs");
});

test("a fixed cap round still waits on CI and on unresolved gate threads before ready", () => {
  assert.equal(draftAt({ draftCapRoundFixed: true, ciStatus: "failure" }).nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(draftAt({ draftCapRoundFixed: true, ciStatus: "pending" }).nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  for (const count of [2, -1]) {
    const threads = draftAt({ draftCapRoundFixed: true, unresolvedGateThreadCount: count });
    assert.equal(threads.nextAction, PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS, String(count));
    assert.ok(threads.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
    assert.equal(/could not be read/.test(threads.reason), count === -1, `${count}: only an unreadable count gets the retry-the-read reason`);
    assert.ok(!/verdict is clean/.test(threads.reason), `${count}: the cap-round reason never claims a clean verdict`);
  }
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

test("a draft PR past the round cap without a fixed cap round reports blocked, never run_draft_gate", () => {
  const refused = draftAt({ draftRoundRefused: true });
  assert.equal(refused.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.ok(refused.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.equal(draftAt({ draftRoundRefused: true, draftCapRoundFixed: true }).nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW, "a fixed cap round wins");
});

// ADR 0218: the refusal names the one failed condition and its own remedy.
test("the cap-round refusal names its failed condition and the remedy for that condition", () => {
  const table = [
    ["baseline_orphaned", /not an ancestor of the current head.*Remedy: push the head to a new branch.*--head <new-branch> --allow-replacement-pr <this PR number>/],
    ["no_clearing_record", /no sealed clearing delta record exists.*Remedy: run `node <dev-loops-package-root>\/cli\/index\.mjs loop pre-push-delta --reviewer-only`.*node <dev-loops-package-root>\/cli\/index\.mjs gate extend-cap-round-chain --repo <owner\/name> --pr <number>/],
    ["unsealed_record", /carries no valid seal.*Remedy: rerun .*loop pre-push-delta --reviewer-only.*never edit the record/],
    ["items_do_not_cover", /act refs of the cap round are not all named by the union of the sealed clearing records.*Remedy: run .*gate extend-cap-round-chain --repo <owner\/name> --pr <number>.*--cover-uncovered/],
    ["cap_round_unresolved", /could not be resolved.*Remedy: repair or quarantine the unreadable ledger or config/],
    ["chain_does_not_reach_head", /ends before the current head.*Remedy: run .*loop pre-push-delta --reviewer-only.* for the current head, or fetch origin\/<base>.*node <dev-loops-package-root>\/cli\/index\.mjs gate extend-cap-round-chain --repo <owner\/name> --pr <number>/],
  ];
  for (const [condition, pattern] of table) {
    const { reason, nextAction } = draftAt({ draftRoundRefused: true, draftCapRoundFailure: condition });
    assert.equal(nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED, condition);
    assert.ok(reason.includes(`Condition ${condition}:`), condition);
    assert.match(reason, pattern, condition);
    for (const [other] of table.filter(([c]) => c !== condition)) assert.ok(!reason.includes(`Condition ${other}:`), `${condition} names only its own condition`);
  }
});

// Issue 3443: items_do_not_cover names the uncovered act refs and the existing records, and keeps its extend-cap-round-chain agent remedy as the recovery.
test("items_do_not_cover names the uncovered act refs and the records that exist", () => {
  const draftCapRoundDetail = { uncovered: ["ref-escalated"], records: [{ baseline: "a".repeat(40), candidate: "b".repeat(40), refs: ["ref-one", "ref-two"] }] };
  const named = draftAt({ draftRoundRefused: true, draftCapRoundFailure: "items_do_not_cover", draftCapRoundDetail, repo: "o/r" });
  assert.match(named.reason, /Uncovered act refs: ref-escalated\. Records on the chain: aaaaaaa\.\.bbbbbbb \[ref-one, ref-two\]\./);
  assert.equal(named.agentRemedy.command, "dev-loops gate extend-cap-round-chain --repo o/r --pr 10");
  assert.ok(!draftAt({ draftRoundRefused: true, draftCapRoundFailure: "no_clearing_record", draftCapRoundDetail }).reason.includes("Uncovered act refs"), "only items_do_not_cover carries the detail");
  assert.ok(!draftAt({ draftRoundRefused: true, draftCapRoundFailure: "items_do_not_cover" }).reason.includes("Uncovered act refs"), "no detail, no suffix");
  // A partial chain's reason never prescribes the plain reviewer-only run for the uncovered ref: that run refuses at the cap-round head and a chain-end baseline derives no items.
  assert.doesNotMatch(named.reason, /so every act ref|reviewer-only` so/u);
  assert.match(named.reason, /extend-cap-round-chain.*--cover-uncovered/u);
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

test("a cap-round refusal with an inherited or unknown condition falls back to cap_round_unresolved", () => {
  for (const condition of ["constructor", "toString", "", "unknown_condition"]) {
    const { reason } = draftAt({ draftRoundRefused: true, draftCapRoundFailure: condition });
    assert.ok(reason.includes("Condition cap_round_unresolved:"), JSON.stringify(condition));
    assert.ok(!reason.includes("native code"), JSON.stringify(condition));
  }
});

test("a cap-round refusal with no reported condition names cap_round_unresolved, never no_clearing_record", () => {
  const { reason } = draftAt({ draftRoundRefused: true, draftCapRoundFailure: null });
  assert.ok(reason.includes("Condition cap_round_unresolved:"));
  assert.ok(!reason.includes("no_clearing_record"));
});

test("a draft clean_cap_verdict_unposted refusal does not claim a missing fixer pass", () => {
  const { reason } = draftAt({ draftRoundRefused: true, draftCapRoundFailure: "clean_cap_verdict_unposted" });
  assert.ok(reason.includes("Condition clean_cap_verdict_unposted:"));
  assert.ok(!reason.includes("fixer pass"));
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
