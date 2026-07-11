// Single source of truth (#1103, #1126) for "did a significant product/test-logic
// change land since the last Copilot review at the round cap". Both
// detect-pr-gate-coordination-state.mjs and copilot-pr-handoff.mjs consume this
// so they agree on the round-cap escape hatch: at the cap, a significant
// post-convergence change reopens a Copilot cycle (rerequest) instead of the
// clean fallback; a doc/comment-only change stays at the clean fallback.
//
// It lives in scripts/loop/ (not packages/core) because significance is derived
// from a `gh api .../compare` diff — gh I/O that does not belong in core.
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import { extractReviewCommitSha, isCopilotLogin, parseJsonText } from "../_core-helpers.mjs";
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";

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
  // Route the docs/ judgment through the shared classifier so a code/config/test
  // file hosted under docs/ is NOT treated as trivial documentation — such a
  // change must re-open a post-convergence Copilot round, not be suppressed.
  if (normalized.startsWith("docs/")) return classifyFile(filePath) === "docs";
  return normalized.endsWith(".md")
    || normalized.endsWith(".mdx")
    || normalized.endsWith(".txt")
    || normalized.endsWith(".rst")
    || normalized.endsWith(".adoc");
}

// Extensions whose comment syntax we can classify with confidence (`//`, `/* */`).
const JS_TS_EXTENSIONS = [".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

// Classifies one line's content given the current block-comment state.
// Returns { code, state }: code=true when the line carries anything that is not
// comment/blank; state = inBlockComment AFTER the line.
// Known ceilings (both err toward significance or genuinely-trivial cases only):
//   - a line STARTING with `//` or `/*` inside a string literal is misread as a
//     comment — such a line still has to literally begin with the token, which
//     real code lines almost never do;
//   - a `/*` opener sitting AFTER code on the same line (`foo(); /* start`) is
//     not tracked (we return code=true immediately) — follow-up `*` body lines
//     then read as code → significant, the safe direction.
function classifyLine(content, inBlock) {
  let rest = content;
  let state = inBlock;
  while (true) {
    if (state) {
      const close = rest.indexOf("*/");
      if (close === -1) return { code: false, state: true };
      rest = rest.slice(close + 2);
      state = false;
      continue;
    }
    const trimmed = rest.trim();
    if (trimmed.length === 0) return { code: false, state };
    if (trimmed.startsWith("//")) return { code: false, state };
    if (trimmed.startsWith("/*")) {
      rest = trimmed.slice(2);
      state = true;
      continue;
    }
    // Anything else is code — including a bare `*`-leading line with NO open
    // block observed: generator signatures (`*items() {`) and operator
    // continuations (`* b`) start with `*` and are real code.
    return { code: true, state };
  }
}

// Content-level significance filter (#1137). A JS/TS file change is "comment-only"
// when EVERY added/removed line in its patch is blank OR a comment line. Such
// changes (JSDoc/inline-comment tweaks) must NOT reopen a Copilot round past the
// cap. Comment rules:
//   - a line starting with `//` is a comment;
//   - `/*` opens block-comment state, `*/` closes it; state is tracked across
//     ALL patch lines (changed AND context) and RESET at every `@@` hunk header
//     — a block opened before the hunk is unobservable, so a `*`-leading line
//     with no observed opener in the same hunk is treated as CODE (conservative:
//     bare `*` counts as comment ONLY inside an observed open `/* ... */` block).
// Conservative by construction — every ambiguous case returns false (= NOT
// classifiable as comment-only; the file remains subject to the existing
// size/count thresholds, it is NOT auto-escalated to significant):
//   - patch missing (binary / oversized to diff)     → false
//   - extension we cannot classify (non-JS/TS code)  → false
//   - a changed line mixing code + comment           → false
//   - a patch with no parseable added/removed lines  → false
// Input contract: GitHub compare `files[].patch` starts at `@@` and never
// contains `---`/`+++` file headers, so `+`/`-` prefixes are always content
// (`+++counter;` is the real added line `++counter;`, not a header).
// Note: line-scanner heuristic, upgrade to a real tokenizer only if string-literal misreads ever bite.
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
  let inBlock = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inBlock = false; // hunk boundary: the gap is unobserved → reset state
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    const content = line.slice(1);
    if (marker === "+" || marker === "-") {
      sawChangedLine = true;
      const { code, state } = classifyLine(content, inBlock);
      if (code) return false;
      inBlock = state;
    } else {
      // Context line: never classified as changed content, but it advances
      // block-comment state so an opener/closer visible in the hunk is honored.
      inBlock = classifyLine(content, inBlock).state;
    }
  }
  // A patch with zero parseable changed lines is ambiguous → treat as code.
  return sawChangedLine;
}

export async function detectPostConvergenceSignificantChange(
  { repo, pr, currentHeadSha, reviews, changedFiles, roundCapReached, regularCopilotRounds },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
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
