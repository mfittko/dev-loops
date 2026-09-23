// Carried convergence: the ONE shared predicate deciding whether a
// post-convergence head bump carries forward the prior converged Copilot
// review instead of forcing a fresh blocking round (ADR 0012).
// request-copilot-review.mjs (marker site, cap site, below-cap site) and
// detect-pr-gate-coordination-state.mjs (postConvergenceReviewSuppressed) both
// call the resolvers here. The request tool never re-requests on a head the
// detector reports as carried, and the detector never reports carried on a
// head where the request tool would re-request.
//
// FAIL CLOSED in every uncertain case: an outstanding request on the current
// head, any unresolved review thread (or an unreadable thread list), no prior
// submitted Copilot review on a strict ancestor head, an unproven or
// non-docs-only delta, or a body-only changes-recommended/unrecognized prior
// review with no thread of its own and no trusted disposition record all
// refuse to carry.
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { resolveConvergenceCarryForward } from "@dev-loops/core/loop/gate-carry-forward";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";
import { fetchGithubReviewThreadsPayload } from "../github/capture-review-threads.mjs";
import {
  isBodyOnlyBlockingReview,
  resolveCopilotBodyDisposition,
  resolveLatestCopilotReview,
  reviewHasOwnThread,
} from "../github/_copilot-body-disposition.mjs";
import { readSuppressionMarker } from "./_post-convergence-review-suppression.mjs";

// The compare API caps `files` at 300 entries per page; a returned list AT
// that cap may be truncated, so a >=300-file delta is never "provably
// pure-doc" from one page.
const COMPARE_FILES_PAGE_CAP = 300;

// The changed-file PATHS between two heads, via a single gh compare call.
// Returns null on ANY uncertainty so the caller re-opens the round: a thrown
// call, a non-zero exit, unparseable JSON, a non-linear advance
// (status !== "ahead"), any rename/copy entry (a destination-path
// classification could misread a code file moved to a doc path as pure-doc),
// a possibly-truncated 300-file page, a missing files array, or any entry
// without a filename (an unnamed entry cannot be classified).
export async function fetchDeltaChangedFiles({ repo, base, head }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  let result;
  try {
    result = await runChild(ghCommand, ["api", `repos/${repo}/compare/${base}...${head}`], env);
  } catch {
    return null;
  }
  if (result?.code !== 0) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (payload?.status !== "ahead") {
    return null;
  }
  const files = payload.files;
  if (!Array.isArray(files) || files.length >= COMPARE_FILES_PAGE_CAP) {
    return null;
  }
  const changed = [];
  for (const file of files) {
    if (file?.status === "renamed" || file?.status === "copied") {
      return null;
    }
    if (typeof file?.filename !== "string" || file.filename.trim().length === 0) {
      return null;
    }
    changed.push(file.filename);
  }
  return changed;
}

// The PR's base branch name, for the base-relative convergence reduction.
// Returns "" on any failure: the caller then skips the reduction and keeps
// the raw delta, so a non-doc delta still re-opens the round.
export async function fetchPrBaseRefName({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  let result;
  try {
    result = await runChild(ghCommand, ["pr", "view", String(pr), "--repo", repo, "--json", "baseRefName", "--jq", ".baseRefName"], env);
  } catch {
    return "";
  }
  if (result.code !== 0) return "";
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

// The most recent SUBMITTED Copilot review (resolveLatestCopilotReview owns
// the selection and its fail-closed tie rule).
export function getLastCopilotReview(prData) {
  return resolveLatestCopilotReview(prData).review;
}

export function getLastCopilotReviewHeadSha(prData) {
  const review = getLastCopilotReview(prData);
  const sha = review?.commit?.oid ?? review?.commit_id;
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}

// The shared delta basis: compare last-reviewed-head..current-head, then
// reduce it to the PR-own (base-relative) delta before classifying, so an
// integrate-only base move carries like a pure doc/prose bump. Returns the
// carry decision when it carries, else null. gh call order: compare
// last..head, baseRefName, compare base..head.
export async function resolveConvergenceCarry({ repo, pr }, runtime, { lastReviewSha, currentHeadSha }) {
  if (!lastReviewSha || !currentHeadSha || lastReviewSha === currentHeadSha) {
    return null;
  }
  const deltaChangedFiles = await fetchDeltaChangedFiles({ repo, base: lastReviewSha, head: currentHeadSha }, runtime);
  if (deltaChangedFiles === null) {
    return null;
  }
  const baseRef = await fetchPrBaseRefName({ repo, pr }, runtime);
  let convergenceDelta = deltaChangedFiles;
  let deltaComplete = false;
  if (baseRef.length > 0) {
    const prOwn = await fetchDeltaChangedFiles({ repo, base: baseRef, head: currentHeadSha }, runtime);
    if (prOwn !== null) {
      const prOwnSet = new Set(prOwn);
      convergenceDelta = deltaChangedFiles.filter((file) => prOwnSet.has(file));
      deltaComplete = true;
    }
  }
  const convergence = resolveConvergenceCarryForward({ changedFiles: convergenceDelta, deltaComplete });
  return convergence.carryForward ? convergence : null;
}

// Raw-delta classification without the base-relative reduction. Used only by
// withdraw-copilot-review-request.mjs to decide whether an operator MAY
// withdraw a stranded request; the suppression decisions use
// resolveConvergenceCarry above. Returns `{ carryForward: false }` whenever the
// delta is unavailable or unproven.
export async function classifyDeltaSinceLastReview({ repo, base, head }, runtime = {}) {
  const deltaChangedFiles = await fetchDeltaChangedFiles({ repo, base, head }, runtime);
  if (deltaChangedFiles === null) {
    return { carryForward: false, reason: "delta since the last reviewed head is unavailable or unproven (fail-closed)" };
  }
  return resolveConvergenceCarryForward({ changedFiles: deltaChangedFiles });
}

// Live thread facts. Returns null when the thread list cannot be read, which
// every caller treats as "not carried".
async function fetchThreadFacts({ repo, pr }, runtime) {
  try {
    const parsed = parseReviewThreads(await fetchGithubReviewThreadsPayload({ repo, pr }, runtime));
    return { unresolvedThreadCount: parsed.summary.unresolvedThreads, reviewThreads: parsed.threads };
  } catch {
    return null;
  }
}

// The shared tail of both carry paths, run after the delta carries: zero
// unresolved threads, then the body-only condition on the prior review.
// `prData` supplies the prior review through resolveLatestCopilotReview, so a
// timestamp tie with two body-blocking latest reviews refuses to carry.
async function finishCarry({ repo, pr, currentHeadSha, prData, sourceHeadSha, delta, source, unresolvedThreadCount, reviewThreads }, runtime) {
  const { review: priorReview, ambiguousBlockingTie } = resolveLatestCopilotReview(prData);
  const sourceReviewId = priorReview?.id !== null && priorReview?.id !== undefined ? String(priorReview.id) : null;
  const bodyBlocking = isBodyOnlyBlockingReview(priorReview);
  let threadFacts = { unresolvedThreadCount, reviewThreads };
  if (typeof unresolvedThreadCount !== "number" || (bodyBlocking && !Array.isArray(reviewThreads))) {
    threadFacts = await fetchThreadFacts({ repo, pr }, runtime);
    if (threadFacts === null) {
      return { carried: false, reason: "the review-thread list is unavailable" };
    }
  }
  if (threadFacts.unresolvedThreadCount !== 0) {
    return { carried: false, reason: `${threadFacts.unresolvedThreadCount} unresolved review thread(s) remain; carried convergence refused (COPILOT-STATE-CARRIED-CONVERGENCE)` };
  }
  if (ambiguousBlockingTie) {
    return { carried: false, reason: "two or more latest Copilot reviews share a timestamp and carry a body finding; no single review owns it" };
  }
  const carried = { carried: true, source, sourceReviewId, sourceHeadSha, reason: delta.reason, bodyDisposition: null };
  if (!bodyBlocking || reviewHasOwnThread(threadFacts.reviewThreads, sourceReviewId)) {
    return carried;
  }
  const record = await resolveCopilotBodyDisposition(
    { repo, pr, headSha: currentHeadSha, reviewId: sourceReviewId, reviewCommitSha: sourceHeadSha },
    runtime,
  );
  if (!record.cleared) {
    return {
      carried: false,
      reason: `the prior Copilot review is body-only changes-recommended or unrecognized with no thread of its own and no trusted disposition record naming it`,
    };
  }
  return { ...carried, bodyDisposition: record.disposition };
}

/**
 * The carried-convergence predicate. All of the following must hold:
 *  1. no Copilot review request is outstanding on the current head;
 *  2. a prior submitted Copilot review exists on a head other than the current
 *     head, and the compare call proves a linear advance from it;
 *  3. the delta since that head is provably docs-only or integrate-only
 *     (resolveConvergenceCarry);
 *  4. zero unresolved review threads;
 *  5. the prior review's body is not changes-recommended/unrecognized, OR that
 *     review opened at least one (now resolved) thread of its own, OR a trusted
 *     disposition record names that review for the current head.
 *
 * `reviewThreads` is the parsed thread list (parseReviewThreads().threads).
 * Thread facts are fetched live only when the caller does not pass them and
 * only after the delta carries, so a non-carrying delta costs no thread read.
 *
 * @returns {Promise<{ carried: true, source: "carried", sourceReviewId: string|null, sourceHeadSha: string, reason: string, bodyDisposition: object|null }
 *   | { carried: false, reason: string }>}
 */
export async function resolveCarriedConvergence({
  repo,
  pr,
  currentHeadSha,
  prData,
  copilotReviewRequestStatus,
  unresolvedThreadCount,
  reviewThreads,
}, runtime = {}) {
  if (copilotReviewRequestStatus !== "none") {
    return { carried: false, reason: "a Copilot review request is outstanding on the current head" };
  }
  if (typeof unresolvedThreadCount === "number" && unresolvedThreadCount !== 0) {
    return { carried: false, reason: `${unresolvedThreadCount} unresolved review thread(s) remain` };
  }
  const priorReview = getLastCopilotReview(prData);
  const lastReviewSha = getLastCopilotReviewHeadSha(prData);
  if (!priorReview || !lastReviewSha || !currentHeadSha || lastReviewSha === currentHeadSha) {
    return { carried: false, reason: "no prior submitted Copilot review on an earlier head" };
  }
  const delta = await resolveConvergenceCarry({ repo, pr }, runtime, { lastReviewSha, currentHeadSha });
  if (!delta) {
    return { carried: false, reason: "the delta since the prior reviewed head is not provably docs-only or integrate-only" };
  }
  return finishCarry(
    { repo, pr, currentHeadSha, prData, sourceHeadSha: lastReviewSha, delta, source: "carried", unresolvedThreadCount, reviewThreads },
    runtime,
  );
}

/**
 * Operator-marker suppression: withdraw-copilot-review-request.mjs recorded a
 * marker for this exact head after an explicit operator withdrawal. The
 * marker never suppresses on its own: the request status must be "none", the
 * live last-reviewed head must equal the marker's claim, the live delta must
 * carry on the shared basis (resolveConvergenceCarry), and the shared tail
 * (zero unresolved threads, the body-only condition) must hold. Any further
 * push changes the head and the marker stops matching.
 *
 * `runtime.checkpointDir` overrides the marker location (tests). Returns the
 * same shape as resolveCarriedConvergence with `source: "marker"`.
 */
export async function resolvePostConvergenceReviewSuppressed({
  repo,
  pr,
  currentHeadSha,
  prData,
  copilotReviewRequestStatus,
  unresolvedThreadCount,
  reviewThreads,
}, runtime = {}) {
  const refused = (reason) => ({ carried: false, reason });
  if (copilotReviewRequestStatus !== "none") return refused("a Copilot review request is outstanding on the current head");
  if (typeof unresolvedThreadCount === "number" && unresolvedThreadCount !== 0) return refused(`${unresolvedThreadCount} unresolved review thread(s) remain`);
  const marker = await readSuppressionMarker({ repo, pr, headSha: currentHeadSha }, { checkpointDir: runtime.checkpointDir });
  if (!marker || marker.headSha !== currentHeadSha) return refused("no operator suppression marker for the current head");
  const liveLastReviewedHeadSha = getLastCopilotReviewHeadSha(prData);
  if (!liveLastReviewedHeadSha || liveLastReviewedHeadSha !== marker.lastReviewedHeadSha) {
    return refused("the marker's last-reviewed head disagrees with the live last Copilot review");
  }
  const delta = await resolveConvergenceCarry({ repo, pr }, runtime, { lastReviewSha: marker.lastReviewedHeadSha, currentHeadSha });
  if (delta === null) return refused("the delta since the prior reviewed head is not provably docs-only or integrate-only");
  return finishCarry(
    {
      repo,
      pr,
      currentHeadSha,
      prData,
      sourceHeadSha: marker.lastReviewedHeadSha,
      delta,
      source: "marker",
      unresolvedThreadCount,
      reviewThreads,
    },
    runtime,
  );
}
