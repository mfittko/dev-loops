// Canonical closing-reference primitives shared by the create-pr / edit-pr
// wrappers so both guard a `Closes #N` / `Fixes #N` body reference against the
// branch's own resolved issue with one implementation. A body swap that
// re-points the reference at a different issue would otherwise pass silently,
// and a merge would then close the wrong issue — this is the fail-closed
// backstop against that data-integrity hole.

const CLOSING_KEYWORD_PATTERN = /Closes\s+#(\d+)|Fixes\s+#(\d+)/i;
const MAX_BODY_SCAN_BYTES = 16 * 1024;

// True when the body carries any `Closes #N` / `Fixes #N` closing keyword.
export function detectClosingKeyword(body) {
  if (!body || typeof body !== "string") return false;
  return CLOSING_KEYWORD_PATTERN.test(body.slice(0, MAX_BODY_SCAN_BYTES));
}

// The issue number from the body's first `Closes #N` / `Fixes #N` reference,
// or null when the body carries none.
export function extractClosingIssueNumber(body) {
  if (!body || typeof body !== "string") return null;
  const match = CLOSING_KEYWORD_PATTERN.exec(body.slice(0, MAX_BODY_SCAN_BYTES));
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

// Branch slug `[<prefix>/]issue-<N>[-<slug>]` -> N. Matches the dev-loop
// worktree default branch name and the prefixed form (e.g. a `dl/`-prefixed
// slug). Returns null when the branch encodes no issue number.
const BRANCH_ISSUE_PATTERN = /(?:^|\/)issue-(\d+)(?:-|$)/u;
export function extractIssueFromBranchSlug(branch) {
  if (!branch || typeof branch !== "string") return null;
  const match = BRANCH_ISSUE_PATTERN.exec(branch.trim());
  return match ? Number(match[1]) : null;
}

// Resolve the issue a PR is expected to close from its own facts. The branch
// slug is authoritative (it encodes the issue the loop cut the branch for);
// the PR's GitHub-derived closingIssuesReferences is the fallback. Returns null
// when neither yields an issue — a genuinely issue-less PR, which is exempt.
export function resolveExpectedIssueFromPrContext(ctx) {
  if (!ctx || typeof ctx !== "object") return null;
  const fromBranch = extractIssueFromBranchSlug(ctx.headRefName);
  if (fromBranch !== null) return fromBranch;
  const refs = Array.isArray(ctx.closingIssuesReferences) ? ctx.closingIssuesReferences : [];
  for (const ref of refs) {
    const n = typeof ref === "number" ? ref : Number(ref?.number);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

// Compare the body's closing reference against the branch's resolved issue.
// Returns a named refusal string when they disagree, else null. A waiver
// bypasses; an unresolved expected issue (issue-less) is exempt; a body with no
// closing reference has nothing to mislink and is exempt (only a present-and-
// disagreeing reference is refused, never a missing one).
export function resolveClosingRefMismatch({ body, expectedIssue, allowCrossIssue = false }) {
  if (allowCrossIssue) return null;
  if (!Number.isInteger(expectedIssue)) return null;
  const closingNumber = extractClosingIssueNumber(body);
  if (closingNumber === null) return null;
  if (closingNumber !== expectedIssue) {
    return `CLOSING-REF-BRANCH-MISMATCH: the body closes #${closingNumber} but the branch resolves to issue #${expectedIssue} — refusing a mismatched closing reference (pass --allow-cross-issue to record a deliberate cross-issue reference)`;
  }
  return null;
}
