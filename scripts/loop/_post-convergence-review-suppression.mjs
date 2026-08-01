// Durable, auditable record of an EXPLICIT operator decision (issue #1441):
// `withdraw-copilot-review-request.mjs` writes this marker only when it withdrew
// a stranded Copilot review request on a head that has ADVANCED past Copilot's
// last submitted review, because the delta since that review is provably a pure
// doc/prose bump (the review's own thread resolutions, not new reviewable
// content). Nothing else creates this file — request-copilot-review.mjs and
// detect-pr-gate-coordination-state.mjs only ever READ it, so the suppression it
// grants is never automatic: it exists only because a human ran the withdrawal.
//
// The marker is scoped to the EXACT head SHA recorded at withdrawal time. Any
// further push changes the current head, the marker no longer matches, and
// every reader falls back to the normal (unsuppressed) round-reopening behavior
// — the marker cannot silently outlive the head it was proven for.
//
// Readers additionally re-run the SAME fail-closed classification
// (resolveConvergenceCarryForward over the delta from `lastReviewedHeadSha` to
// the current head) before trusting the marker, rather than trusting its stored
// `reason` blindly — defense in depth against a stale or hand-edited file.
//
// Reuses the existing tmp/copilot-loop/<owner>/<repo>/pr-<n>/ checkpoint
// directory convention (buildDefaultCheckpointDir) rather than inventing a new
// on-disk location.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonText } from "../_core-helpers.mjs";
import { buildDefaultCheckpointDir } from "./_checkpoint-paths.mjs";

const MARKER_FILENAME = "post-convergence-review-suppression.json";

export function buildSuppressionMarkerPath(repo, pr, { checkpointDir } = {}) {
  const dir = checkpointDir ?? buildDefaultCheckpointDir(repo, pr);
  return path.join(dir, MARKER_FILENAME);
}

/**
 * Persist the operator-authorized suppression record. Called only from the
 * head-advanced branch of withdraw-copilot-review-request.mjs, after the
 * stranded review request has actually been removed.
 *
 * @param {object} params
 * @param {string} params.repo
 * @param {number} params.pr
 * @param {string} params.headSha - the exact current head the withdrawal was proven for
 * @param {string} params.lastReviewedHeadSha - the head of Copilot's last submitted review
 * @param {string} params.reason - the carry-forward classifier's own reason string
 * @param {string|null} [params.operatorReason] - the operator's --reason, if given
 */
export async function writeSuppressionMarker(
  { repo, pr, headSha, lastReviewedHeadSha, reason, operatorReason = null },
  { checkpointDir } = {},
) {
  const filePath = buildSuppressionMarkerPath(repo, pr, { checkpointDir });
  await mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    repo,
    pr,
    headSha,
    lastReviewedHeadSha,
    reason,
    operatorReason,
    withdrawnAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { filePath, record };
}

/**
 * Read the suppression marker, if any. Fails closed to `null` (no suppression)
 * on any read/parse error, including a missing file — a corrupt or absent
 * marker must never be mistaken for an authorized one.
 *
 * @returns {Promise<{ repo, pr, headSha, lastReviewedHeadSha, reason, operatorReason, withdrawnAt }|null>}
 */
export async function readSuppressionMarker({ repo, pr }, { checkpointDir } = {}) {
  const filePath = buildSuppressionMarkerPath(repo, pr, { checkpointDir });
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = parseJsonText(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.headSha !== "string" || typeof parsed.lastReviewedHeadSha !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
