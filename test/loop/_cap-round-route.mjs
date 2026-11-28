// Shared driver for the cap-round tests (issue 3122, ADR 0255): the REAL extend-cap-round-chain tool, the REAL cap-round proof and the REAL evaluatePrGateCoordination.
// Only the network seams (gh PR state, git fetch) are injected.
import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";
import { DISPOSITION, STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { isRoundRefused } from "@dev-loops/core/loop/review-round-cap";
import { resolveDraftCapRoundFact, resolveDraftRoundCap } from "../../scripts/github/write-gate-context.mjs";
import { extendCapRoundChain } from "../../scripts/loop/extend-cap-round-chain.mjs";

export const extendRoute = (root, { repo, pr, head }) => extendCapRoundChain({ repo, pr, worktree: root }, {
  detectOriginSlug: () => repo, fetchPr: async () => ({ headRefOid: head, baseRefName: "main", isDraft: true }), fetchBaseBranch: () => {},
});

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
