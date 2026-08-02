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
//
// #1441 follow-up (fail-closed default was cwd-relative): the writer
// (a human-run operator tool) and the readers (the loop, running in a PR
// worktree) routinely execute from DIFFERENT checkouts of this repo. A plain
// cwd-relative default silently lands the marker where no reader looks — the
// exact #1050 failure class this repo already solved for cross-process
// evidence. The default DIRECTORY is now anchored, mirroring that fix:
//   - writer: resolveRepoRoot(process.cwd()) — the writer's own checkout root,
//     not whatever subdirectory the operator happened to be in.
//   - reader: every checkout resolveLedgerCheckouts(process.cwd()) enumerates
//     (this checkout's root + every git worktree, main included), so a marker
//     written in one checkout is still found when read from another — mirrors
//     ledgerExistsInAny in scripts/github/detect-checkpoint-evidence.mjs.
// An explicit checkpointDir (tests; a future --checkpoint-dir override) always
// wins and skips this anchoring/search entirely.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonText } from "../_core-helpers.mjs";
import { buildDefaultCheckpointDir } from "./_checkpoint-paths.mjs";
import { resolveLedgerCheckouts, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const MARKER_FILENAME = "post-convergence-review-suppression.json";

export function buildSuppressionMarkerPath(repo, pr, { checkpointDir, repoRoot } = {}) {
  const dir = checkpointDir ?? path.join(repoRoot ?? resolveRepoRoot(process.cwd()), buildDefaultCheckpointDir(repo, pr));
  return path.join(dir, MARKER_FILENAME);
}

function isValidMarker(parsed, { repo, pr }) {
  if (!parsed || typeof parsed !== "object") return false;
  if (typeof parsed.headSha !== "string" || typeof parsed.lastReviewedHeadSha !== "string") return false;
  // Identity check: reject a marker whose own recorded repo/pr doesn't match
  // the request, so a hand-edited or misplaced file (e.g. found via the
  // multi-checkout search below) cannot be mistaken for this PR's marker.
  if (typeof parsed.repo !== "string" || parsed.repo.trim().toLowerCase() !== String(repo).trim().toLowerCase()) return false;
  if (Number(parsed.pr) !== Number(pr)) return false;
  return true;
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

async function readMarkerAt(filePath, identity) {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = parseJsonText(text);
    if (!isValidMarker(parsed, identity)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read the suppression marker, if any. Fails closed to `null` (no suppression)
 * on any read/parse error, including a missing file, malformed content, or a
 * recorded repo/pr identity that doesn't match the request — a corrupt,
 * foreign, or absent marker must never be mistaken for an authorized one.
 *
 * With an explicit `checkpointDir` (tests; a future CLI override), reads
 * exactly that path. Otherwise searches every checkout `resolveLedgerCheckouts`
 * enumerates (this checkout + every git worktree, main included) and returns
 * the first valid marker found, so a marker written from a different checkout
 * than the one this reader runs in is still found.
 *
 * @returns {Promise<{ repo, pr, headSha, lastReviewedHeadSha, reason, operatorReason, withdrawnAt }|null>}
 */
export async function readSuppressionMarker({ repo, pr }, { checkpointDir } = {}) {
  if (checkpointDir) {
    return readMarkerAt(buildSuppressionMarkerPath(repo, pr, { checkpointDir }), { repo, pr });
  }
  for (const repoRoot of resolveLedgerCheckouts(process.cwd())) {
    const marker = await readMarkerAt(buildSuppressionMarkerPath(repo, pr, { repoRoot }), { repo, pr });
    if (marker) return marker;
  }
  return null;
}
