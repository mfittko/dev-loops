// Shared driver for the cap-round dead-end tests (issue 3122, ADR 0255): the REAL reviewer-only delta CLI, the REAL extend-cap-round-chain tool,
// the REAL cap-round proof and the REAL evaluatePrGateCoordination. Only the network seams (gh PR state, git fetch) are injected.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";
import { DISPOSITION, STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { isRoundRefused } from "@dev-loops/core/loop/review-round-cap";
import { resolveDraftCapRoundFact, resolveDraftRoundCap } from "../../scripts/github/write-gate-context.mjs";
import { readGateDeltaRecord, readSealedCoverRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { extendCapRoundChain } from "../../scripts/loop/extend-cap-round-chain.mjs";
import { runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { sealDeltaFixture } from "./_seal-fixture.mjs";

const seam = { stdout: { write: () => {} }, fetchBase: () => {}, fetchPr: async () => ({ baseRefName: "main", isDraft: true }) };

export const extendRoute = (root, { repo, pr, head }) => extendCapRoundChain({ repo, pr, worktree: root }, {
  detectOriginSlug: () => repo, fetchPr: async () => ({ headRefOid: head, baseRefName: "main", isDraft: true }), fetchBaseBranch: () => {},
});

/** The reviewer-only delta for baseline..head: the input run, a sealed reviewer result marking every derived act item `status`, then the result run. */
export async function reviewerOnlyRoute(root, { baseline, head, ledgerPath, status = "resolved", extraResult = {}, cover = false }) {
  const tmp = path.join(root, "tmp");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const logPath = ledgerPath; // the canonical ledger itself: the route refuses any other file
  writeFileSync(logPath, JSON.stringify({ ...ledger, provenance: ledger.provenance?.perAngle?.length ? ledger.provenance : { perAngle: [{ angle: "correctness" }] } }));
  // `cover`: the cover run (ADR 0255 amendment): the same reviewer-only CLI limited to the uncovered act refs, sealing one cover record per ref instead of a baseline record.
  const args = ["--reviewer-only", ...(cover ? ["--cover-uncovered"] : []), "--repo", ledger.repo, "--pr", String(ledger.pr), "--baseline", baseline, "--pr-head", head, "--findings-log", logPath, "--worktree", root];
  const resultPath = path.join(root, "reviewer-result.json");
  const { input } = await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", resultPath], seam);
  const actionableItems = input.actItems.map((item) => ({ ref: item.ref, status, evidence: ["src/x.mjs:1"] }));
  // A truthful reviewer reads every stale-surface hit and names its file in a nit finding (PRE-PUSH-DELTA-RESULT).
  const newFindings = [...new Set((input.staleSurfaceHits ?? []).map((hit) => hit.file ?? hit.site?.split(":")[0]))].map((file) => ({ severity: "nit", summary: `${file}: the removed wording is reworded, not stale`, evidence: [`${file}:1`], site: file }));
  writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems, newFindings, widenedReads: [], outcome: status === "resolved" ? "locally_clear" : "needs_fix", ...extraResult }));
  sealDeltaFixture(tmp, resultPath);
  const priorCount = cover ? Math.max(0, ...input.actItems.map((item) => readSealedCoverRecord(tmp, baseline, item.ref)?.invocation ?? 0)) : readGateDeltaRecord(tmp, baseline)?.invocation;
  const invocation = (Number.isInteger(priorCount) ? priorCount : 0) + 1;
  const decision = await runDeltaCli([...args, "--result", resultPath, "--invocation", String(invocation)], seam);
  return { input, decision };
}

/** The coordinator's view of a draft PR at `head`: the proof as detect-pr-gate-coordination-state computes it, then the real evaluator. */
export async function coordinationAt(root, { repo, pr, head, ready = false, reviews, trustRuntime, draftOpenActList }) {
  // Without `reviews` these scenarios exercise the chain-extension exits, not the posted-verdict check; `reviews` (the PR's posted reviews) turns that check on.
  const { capRoundFixed: fixed, failure, failureDetail } = await resolveDraftCapRoundFact({ repo, pr, currentHeadSha: head, prData: { isDraft: !ready, baseRefName: "main", ...(reviews ? { reviews } : {}) } }, { repoRoot: root, requirePostedCleanCap: reviews !== undefined, ...(trustRuntime ? { trustRuntime } : {}) });
  const { round, cap } = await resolveDraftRoundCap({ repo, pr, gate: "draft_gate", headSha: head }, { repoRoot: root, includeLiveCurrentHead: true, prBase: "main" });
  const marker = { visible: true, headSha: "abc1234", verdict: "blocked", contractComplete: true };
  const result = evaluatePrGateCoordination({
    pr, repo, currentHeadSha: head, prDraft: !ready, lifecycleState: ready ? STATE.READY_TO_REREQUEST_REVIEW : STATE.PR_DRAFT_NO_FEEDBACK, loopDisposition: ready ? DISPOSITION.CLEAN_CONVERGED : DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
    maxCopilotRounds: 0, copilotReviewRoundCount: 0, unresolvedThreadCount: 0, unresolvedGateThreadCount: 0, prTitle: "feat: x",
    ...(ready ? { sameHeadCleanConverged: true, draftGate: marker, draftGateMarker: marker, preApprovalGate: { visible: false }, preApprovalGateMarker: { visible: false } } : {}),
    // The detector refuses the draft round only past the cap (round > cap): below it the next draft_gate round runs.
    ...(draftOpenActList ? { draftOpenActList } : {}),
    draftCapRoundFixed: fixed, draftRoundRefused: !ready && !fixed && isRoundRefused(round, cap), draftCapRoundFailure: failure, draftCapRoundDetail: failureDetail,
  });
  return { fixed, failure, nextAction: result.nextAction, remedy: result.agentRemedy?.command ?? null, blockedOn: result.blockedOn ?? null, reason: result.reason };
}

/**
 * The remedy loop an agent follows from a report_blocked cap-round state: the extension command, then (when it refuses a logic range) the reviewer-only delta, then the extension again.
 * `ledgerPath` is the cap-round ledger at `baseline`; `reviewerStatus` is what a truthful reviewer reports for the derived act items.
 * Returns the trace of each step and the coordinator's end state.
 */
export async function followRemedy(root, { repo, pr, head, baseline, ledgerPath, reviewerStatus = "resolved" }) {
  const trace = [];
  const step = async (name, fn) => {
    try { const r = await fn(); trace.push(`${name}: ${r.ok === false ? r.reason : r.action ?? (r.decision ? JSON.stringify(r.decision) : "ok")}`); return r; } catch (error) { trace.push(`${name}: refused ${String(error.message).slice(0, 700)}`); return { ok: false, thrown: error }; }
  };
  let end = await coordinationAt(root, { repo, pr, head });
  if (end.fixed) return { trace: ["already proven"], end };
  const extended = await step("extend", () => extendRoute(root, { repo, pr, head }));
  if (!extended.ok) {
    // Execute the one command the refusal names (RECOVERY-COMMAND-REQUIRED): a wrong recovery fails the caller's end-state assertion.
    // A reviewer-only recovery runs at the baseline it names, then the extension again; any other recovery (gate-coordination) is the coordinator check below.
    // A refusal that names no recovery keeps the baseline the caller hands in.
    const recovery = extended.recovery ?? "";
    trace.push(`recovery: ${recovery}`);
    const named = /loop pre-push-delta --reviewer-only .*--baseline (\S+) /u.exec(recovery);
    if (named || !recovery) {
      await step(recovery.includes("--cover-uncovered") ? "cover-run" : "reviewer-only", () => reviewerOnlyRoute(root, { baseline: named?.[1] ?? baseline, head, ledgerPath, status: reviewerStatus, cover: recovery.includes("--cover-uncovered") }));
      await step("extend", () => extendRoute(root, { repo, pr, head }));
    }
  }
  end = await coordinationAt(root, { repo, pr, head });
  return { trace, end };
}

/**
 * The thread-route delta for baseline..head (issue 3443): the REAL CLI with a list-review-threads file of one unresolved thread, a sealed reviewer result marking that thread `resolved`, then the result run.
 * It seals a record whose item ref is the thread id, as a fixer pass over an escalated item in the PR does.
 */
export async function threadRoute(root, { repo, pr, baseline, threadId }) {
  const tmp = path.join(root, "tmp");
  const threadsFile = path.join(root, "threads.json");
  writeFileSync(threadsFile, JSON.stringify({ ok: true, repo, pr, threads: [{ trusted: true, threadId, commentId: 1, body: "fix the escalated defect", isResolved: false, path: "src/a.mjs", line: 3 }] }));
  const args = ["--threads-file", threadsFile, "--repo", repo, "--pr", String(pr), "--baseline", baseline, "--worktree", root];
  const resultPath = path.join(root, "thread-result.json");
  const { input } = await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", resultPath], seam);
  const newFindings = [...new Set((input.staleSurfaceHits ?? []).map((hit) => hit.file ?? hit.site?.split(":")[0]))].map((file) => ({ severity: "nit", summary: `${file}: the removed wording is reworded, not stale`, evidence: [`${file}:1`], site: file }));
  writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: input.actItems.map((item) => ({ ref: item.ref, status: "resolved", evidence: ["src/a.mjs:1"] })), newFindings, widenedReads: [], outcome: "locally_clear" }));
  sealDeltaFixture(tmp, resultPath);
  return runDeltaCli([...args, "--result", resultPath, "--invocation", "1"], seam);
}
