// Single source of truth (#1103, #1126) for "did a significant product/test-logic
// change land since the last Copilot review at the round cap". Both
// detect-pr-gate-coordination-state.mjs and copilot-pr-handoff.mjs consume this
// so they agree on the round-cap escape hatch: at the cap, a significant
// post-convergence change reopens a Copilot cycle (rerequest) instead of the
// clean fallback; a doc/comment-only change stays at the clean fallback.
//
// It lives in scripts/loop/ (not packages/core) because significance is derived
// from a `gh api .../compare` diff — gh I/O that does not belong in core.
import { extractReviewCommitSha, isCopilotLogin, parseJsonText } from "../_core-helpers.mjs";
import { runChild } from "../_cli-primitives.mjs";

export function getLatestSubmittedCopilotReviewHeadSha(reviews) {
  const copilotSubmitted = (Array.isArray(reviews) ? reviews : [])
    .filter((review) => {
      const login = review?.author?.login;
      const state = String(review?.state ?? "").toUpperCase();
      return isCopilotLogin(login) && state !== "PENDING";
    })
    .map((review, index) => {
      const submittedAt = review?.submittedAt ?? review?.submitted_at;
      const submittedAtMs = typeof submittedAt === "string" ? Date.parse(submittedAt) : Number.NaN;
      return { review, submittedAtMs, index };
    })
    .sort((left, right) => {
      const leftValid = !Number.isNaN(left.submittedAtMs);
      const rightValid = !Number.isNaN(right.submittedAtMs);
      if (leftValid && rightValid) {
        return right.submittedAtMs - left.submittedAtMs;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return right.index - left.index;
    });
  const latest = copilotSubmitted[0]?.review;
  const sha = extractReviewCommitSha(latest);
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}

export function isTrivialDocumentationOnlyPath(filePath) {
  if (typeof filePath !== "string") return true;
  const normalized = filePath.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized.startsWith("docs/")) return true;
  return normalized.endsWith(".md")
    || normalized.endsWith(".mdx")
    || normalized.endsWith(".txt")
    || normalized.endsWith(".rst")
    || normalized.endsWith(".adoc");
}

export async function detectPostConvergenceSignificantChange(
  { repo, pr, currentHeadSha, reviews, changedFiles, roundCapReached, regularCopilotRounds },
  { env = process.env, ghCommand = "gh" } = {},
) {
  if (!roundCapReached || !regularCopilotRounds) {
    return false;
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return false;
  }
  const lastReviewedHeadSha = getLatestSubmittedCopilotReviewHeadSha(reviews);
  if (!lastReviewedHeadSha || lastReviewedHeadSha === currentHeadSha) {
    return false;
  }
  const compareResult = await runChild(
    ghCommand,
    ["api", `repos/${repo}/compare/${lastReviewedHeadSha}...${currentHeadSha}`],
    env,
  );
  if (compareResult.code !== 0) {
    return false;
  }
  let payload;
  try {
    payload = parseJsonText(compareResult.stdout, { label: "gh compare" });
  } catch {
    return false;
  }
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length === 0) {
    return false;
  }
  const hasNonDocChanges = files.some((file) => !isTrivialDocumentationOnlyPath(file?.filename));
  if (!hasNonDocChanges) {
    return false;
  }
  const totalChangedLines = files.reduce((sum, file) => {
    const changes = Number(file?.changes);
    if (Number.isFinite(changes) && changes > 0) {
      return sum + changes;
    }
    const additions = Number(file?.additions);
    const deletions = Number(file?.deletions);
    const fallback = (Number.isFinite(additions) ? additions : 0) + (Number.isFinite(deletions) ? deletions : 0);
    return sum + (fallback > 0 ? fallback : 0);
  }, 0);
  return totalChangedLines >= 20 || files.length >= 2;
}
