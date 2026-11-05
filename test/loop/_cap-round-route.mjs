// Shared driver for the cap-round dead-end tests (issue 3122, ADR 0255): the REAL reviewer-only delta CLI, the REAL extend-cap-round-chain tool,
// the REAL cap-round proof and the REAL evaluatePrGateCoordination. Only the network seams (gh PR state, git fetch) are injected.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";
import { DISPOSITION, STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { resolveCapRoundFixed } from "../../scripts/github/write-gate-context.mjs";
import { readGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { extendCapRoundChain } from "../../scripts/loop/extend-cap-round-chain.mjs";
import { runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { sealDeltaFixture } from "./_seal-fixture.mjs";

const seam = { stdout: { write: () => {} }, fetchBase: () => {} };

export const extendRoute = (root, { repo, pr, head }) => extendCapRoundChain({ repo, pr, worktree: root }, {
  detectOriginSlug: () => repo, fetchPr: async () => ({ headRefOid: head, baseRefName: "main" }), fetchBaseBranch: () => {},
});

/** The reviewer-only delta for baseline..head: the input run, a sealed reviewer result marking every derived act item `status`, then the result run. */
export async function reviewerOnlyRoute(root, { baseline, head, ledgerPath, status = "resolved", extraResult = {} }) {
  const tmp = path.join(root, "tmp");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const logPath = ledgerPath; // the canonical ledger itself: the route refuses any other file
  writeFileSync(logPath, JSON.stringify({ ...ledger, provenance: ledger.provenance?.perAngle?.length ? ledger.provenance : { perAngle: [{ angle: "correctness" }] } }));
  const args = ["--reviewer-only", "--repo", ledger.repo, "--pr", String(ledger.pr), "--baseline", baseline, "--pr-head", head, "--findings-log", logPath, "--worktree", root];
  const resultPath = path.join(root, "reviewer-result.json");
  const { input } = await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", resultPath], seam);
  const actionableItems = input.actItems.map((item) => ({ ref: item.ref, status, evidence: ["src/x.mjs:1"] }));
  // A truthful reviewer reads every stale-surface hit and names its file in a nit finding (PRE-PUSH-DELTA-RESULT).
  const newFindings = [...new Set((input.staleSurfaceHits ?? []).map((hit) => hit.file ?? hit.site?.split(":")[0]))].map((file) => ({ severity: "nit", summary: `${file}: the removed wording is reworded, not stale`, evidence: [`${file}:1`], site: file }));
  writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems, newFindings, widenedReads: [], outcome: status === "resolved" ? "locally_clear" : "needs_fix", ...extraResult }));
  sealDeltaFixture(tmp, resultPath);
  const prior = readGateDeltaRecord(tmp, baseline);
  const invocation = (Number.isInteger(prior?.invocation) ? prior.invocation : 0) + 1;
  const decision = await runDeltaCli([...args, "--result", resultPath, "--invocation", String(invocation)], seam);
  return { input, decision };
}

/** The coordinator's view of a draft PR at `head`: the proof as detect-pr-gate-coordination-state computes it, then the real evaluator. */
export async function coordinationAt(root, { repo, pr, head }) {
  let failure = null;
  const fixed = Boolean(await resolveCapRoundFixed({ repo, pr, headSha: head, baseRefName: "main", anyHead: false }, { repoRoot: root, onFailure: (c) => { failure = c; } }).catch(() => { failure = "cap_round_unresolved"; return null; }));
  const result = evaluatePrGateCoordination({
    pr, repo, currentHeadSha: head, prDraft: true, lifecycleState: STATE.PR_DRAFT_NO_FEEDBACK, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
    maxCopilotRounds: 0, copilotReviewRoundCount: 0, unresolvedThreadCount: 0, unresolvedGateThreadCount: 0, prTitle: "feat: x",
    draftCapRoundFixed: fixed, draftRoundRefused: !fixed, draftCapRoundFailure: failure,
  });
  return { fixed, failure, nextAction: result.nextAction, remedy: result.agentRemedy?.command ?? null, reason: result.reason };
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
    await step("reviewer-only", () => reviewerOnlyRoute(root, { baseline, head, ledgerPath, status: reviewerStatus }));
    await step("extend", () => extendRoute(root, { repo, pr, head }));
  }
  end = await coordinationAt(root, { repo, pr, head });
  return { trace, end };
}
