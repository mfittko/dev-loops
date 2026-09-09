import { runChild as defaultRunChild } from "../_cli-primitives.mjs";

// GATE-EXEC-FIXER-DISPOSITION-BOUNDARY containment primitive: is a fixing
// commit provably part of the observed PR head's history? A SHA alone is
// never evidence (Non-goals: "treating a commit SHA without remote/head-
// containment verification as evidence") — only this injected fact may
// authorize the reply/resolve steps in fixer-disposition.mjs's evaluator.
//
// One `gh api repos/{repo}/compare/{commitSha}...{headSha}` call, reusing the
// same compare-status pattern as request-copilot-review.mjs's
// fetchDeltaChangedFiles. GitHub's compare status describes HEAD relative to
// BASE (base=commitSha, head=headSha here):
//   - "identical": commitSha === headSha (trivially contained)
//   - "ahead": headSha has additional commits beyond commitSha, i.e. commitSha
//     IS an ancestor of headSha — contained
//   - "behind": headSha is an ancestor of commitSha instead (the alleged
//     fixing commit is not yet reachable from the observed head) — NOT contained
//   - "diverged": neither is an ancestor of the other — NOT contained
// Fails closed (not-contained, retryable) on any API error, non-zero exit, or
// unparseable/unexpected payload — an uncertain answer must never read as
// contained.
export async function isCommitContainedByHead(
  { repo, commitSha, headSha },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
) {
  let result;
  try {
    result = await runChild(ghCommand, ["api", `repos/${repo}/compare/${commitSha}...${headSha}`], env);
  } catch (error) {
    return {
      contained: false,
      reason: `gh compare failed: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }
  if (result.code !== 0) {
    return {
      contained: false,
      reason: `gh compare exited ${result.code}: ${(result.stderr || "").trim() || "<no stderr>"}`,
      retryable: true,
    };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { contained: false, reason: "gh compare returned unparseable JSON", retryable: true };
  }
  const status = payload?.status;
  if (status === "identical" || status === "ahead") {
    return { contained: true, reason: null, retryable: false };
  }
  if (status === "behind" || status === "diverged") {
    return {
      contained: false,
      reason: `commit ${commitSha} is not contained by head ${headSha} (compare status: ${status})`,
      retryable: false,
    };
  }
  return { contained: false, reason: `unexpected compare status: ${JSON.stringify(status)}`, retryable: true };
}

/**
 * Build a { commitSha: contained } map for a list of unique commit SHAs
 * against one observed PR head. One compare call per unique SHA.
 */
export async function buildContainmentMap(commitShas, { repo, headSha }, runtime = {}) {
  const containment = {};
  for (const commitSha of new Set(commitShas)) {
    const result = await isCommitContainedByHead({ repo, commitSha, headSha }, runtime);
    containment[commitSha] = result.contained;
  }
  return containment;
}
