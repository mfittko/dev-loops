/**
 * Fresh human approval for a PR that changes the `.devloops`
 * `standingAuthorizations` block (ADR-TRIPWIRE-STANDING-WAIVER). Shared by
 * ready-for-review.mjs and pre-pr-ready-gate.mjs so the policy cannot be
 * widened under a standing merge authorization.
 */
import { ghJson } from "@dev-loops/core/github/gh";
import { verifyFreshHumanApproval } from "@dev-loops/core/loop/merge-approval";
import { filterAskApprovalComments, ASK_APPROVAL_RECOVERY } from "@dev-loops/core/github/ask-merge-approval";
import { flattenPaginatedSlurp } from "./post-gate-findings.mjs";

export const STANDING_AUTHORIZATIONS_TRIGGER = "standing-authorizations-change";

export const policyChangeApprovalRequired = (adrTripwire) =>
  Array.isArray(adrTripwire?.triggers) && adrTripwire.triggers.some((t) => t.type === STANDING_AUTHORIZATIONS_TRIGGER);

/**
 * @returns {Promise<{ required: boolean, satisfied: boolean, approvedBy?: string, via?: string|null, reason?: string|null }>}
 */
export async function verifyPolicyChangeApproval({ repo, pr, headSha, adrTripwire }, { env, ghCommand = "gh", runChild } = {}) {
  if (!policyChangeApprovalRequired(adrTripwire)) return { required: false, satisfied: true };
  const read = (suffix) => ghJson(["api", "--paginate", "--slurp", `repos/${repo}/${suffix}?per_page=100`], { env, ghCommand, runChild });
  // GitHub logins are case-insensitive: take the canonical owner login from the API, not the --repo spelling.
  const approvedBy = (await ghJson(["api", `repos/${repo}`], { env, ghCommand, runChild }))?.owner?.login ?? repo.split("/")[0];
  const reviews = flattenPaginatedSlurp(await read(`pulls/${pr}/reviews`));
  const comments = flattenPaginatedSlurp(await read(`issues/${pr}/comments`));
  // One approval rule for every reader: a hook-marked or (with the hook key) any approve-merge comment counts only with its harness record (MERGE-ASK-APPROVAL).
  const askApproval = filterAskApprovalComments({ comments, repo, pr: Number(pr), currentHeadSha: headSha, env });
  const result = verifyFreshHumanApproval({ approvedBy, currentHeadSha: headSha, reviews, comments: askApproval.comments });
  return { required: true, approvedBy, ...result, ...(result.satisfied || askApproval.refusals.length === 0 ? {} : { reason: [result.reason, ...askApproval.refusals].filter(Boolean).join(" ") }) };
}

export function policyChangeApprovalRefusal({ pr, headSha, approval }) {
  return (
    `PR #${pr} changes the .devloops standingAuthorizations block and cannot become ready without a fresh human approval at the current head ${headSha.slice(0, 7)}: ` +
    `${approval.reason ?? "no approval found"}. The repo owner (${approval.approvedBy}) must leave an APPROVED review, or answer the approval question under Claude Code (MERGE-ASK-APPROVAL: ${ASK_APPROVAL_RECOVERY}), or, on a machine without the hook key, leave an \`approve merge ${headSha}\` comment.`
  );
}
