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

// Extensions whose comment syntax we can classify with confidence (`//`, `/* */`).
const JS_TS_EXTENSIONS = [".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

// Content-level significance filter (#1137). A JS/TS file change is "comment-only"
// when EVERY added/removed line in its patch is blank OR a comment line. Such
// changes (JSDoc/inline-comment tweaks) must NOT reopen a Copilot round past the
// cap. Conservative by construction — every ambiguous case returns false (= NOT
// comment-only = treated as code = keeps the file in the significance math):
//   - patch missing (binary / too large to diff)    → false
//   - extension we cannot classify (non-JS/TS code)  → false
//   - a changed line mixing code + comment           → false
//   - a patch with no parseable added/removed lines  → false
// Known ceiling (documented, accepted toward significance only): a changed line
// whose trimmed content STARTS with a comment token is treated as a comment even
// if that token lives inside a string literal (e.g. `const s = "// x"` is rare
// because such a line still starts with `const`, not `//`). This can only ever
// mis-classify a line that literally begins with `//`, `/*`, `*`, or `*/`, which
// for real code is a comment — so the ceiling errs toward calling a change
// comment-only only in vanishingly rare, genuinely-trivial cases.
// ponytail: line-prefix heuristic, upgrade to a real tokenizer only if string-literal misreads ever bite.
export function isCommentOnlyFileChange(file) {
  const filename = typeof file?.filename === "string" ? file.filename : "";
  const lower = filename.toLowerCase();
  if (!JS_TS_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    // Not a classifiable code file (or a doc path handled elsewhere) → treat as code.
    return false;
  }
  const patch = file?.patch;
  if (typeof patch !== "string" || patch.length === 0) {
    // No patch (binary / too large) → cannot prove trivial → treat as code.
    return false;
  }
  let sawChangedLine = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers
    if (line.startsWith("@@")) continue; // hunk header
    if (line[0] !== "+" && line[0] !== "-") continue; // context / metadata
    sawChangedLine = true;
    const trimmed = line.slice(1).trim();
    if (trimmed.length === 0) continue; // blank line
    if (
      trimmed.startsWith("//")
      || trimmed.startsWith("/*")
      || trimmed.startsWith("*") // covers block-comment body and `*/`
    ) {
      continue; // comment line
    }
    return false; // a real (or mixed code+comment) line → not comment-only
  }
  // A patch with zero parseable changed lines is ambiguous → treat as code.
  return sawChangedLine;
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
  if (!currentHeadSha) {
    // No usable current head → the compare call would be doomed; fail closed
    // without issuing a wasted gh API request.
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
  const rawFiles = Array.isArray(payload?.files) ? payload.files : [];
  if (rawFiles.length === 0) {
    return false;
  }
  // Content-aware filter (#1137): drop comment/JSDoc-only JS/TS changes BEFORE the
  // existing size/count thresholds so trivial comment fixes no longer reopen a
  // Copilot round past the cap. Doc paths and un-classifiable files fall through
  // unchanged (isCommentOnlyFileChange returns false for them), preserving the
  // prior threshold behavior for everything else.
  const files = rawFiles.filter((file) => !isCommentOnlyFileChange(file));
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
