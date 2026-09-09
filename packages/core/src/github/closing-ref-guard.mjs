// Canonical closing-reference primitives shared by the create-pr / edit-pr
// wrappers so both guard a `Closes #N` / `Fixes #N` body reference against the
// branch's own resolved issue with one implementation. A body swap that
// re-points the reference at a different issue would otherwise pass silently,
// and a merge would then close the wrong issue — this is the fail-closed
// backstop against that data-integrity hole.

// GitHub auto-closes a linked issue on ANY of its closing keywords in ANY case
// (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved) — not only
// Closes/Fixes. The guard must recognize the full set, or a swapped body using
// e.g. `Resolves #N` would slip past yet still close the wrong issue on merge.
// The pattern is GLOBAL because a body may carry several references and GitHub
// honors every one; the mismatch check inspects them all, not just the first.
// Never call `.test()`/`.exec()` on this shared global regex (they mutate its
// lastIndex) — route through extractClosingIssueNumbers, which uses matchAll.
const CLOSING_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b\s+#(\d+)/gi;
const MAX_BODY_SCAN_BYTES = 16 * 1024;

// Every issue number the body's closing references name, in order, de-duplicated.
export function extractClosingIssueNumbers(body) {
  if (!body || typeof body !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const match of body.slice(0, MAX_BODY_SCAN_BYTES).matchAll(CLOSING_KEYWORD_PATTERN)) {
    const n = Number(match[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// True when the body carries any closing keyword.
export function detectClosingKeyword(body) {
  return extractClosingIssueNumbers(body).length > 0;
}

// The issue number from the body's first closing reference, or null when the
// body carries none. Back-compat surface (create-pr's `--issue` missing-reference
// check); the mismatch guard uses extractClosingIssueNumbers to see every one.
export function extractClosingIssueNumber(body) {
  const all = extractClosingIssueNumbers(body);
  return all.length > 0 ? all[0] : null;
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
  const closing = extractClosingIssueNumbers(body);
  if (closing.length === 0) return null;
  // Refuse when ANY closing reference disagrees — GitHub closes every one, so a
  // correct first reference does not excuse a wrong second (a single-issue
  // dev-loop PR closes only its branch's issue; a deliberate multi/cross-issue
  // reference uses the waiver).
  const disagreeing = closing.find((n) => n !== expectedIssue);
  if (disagreeing !== undefined) {
    return `CLOSING-REF-BRANCH-MISMATCH: the body closes #${disagreeing} but the branch resolves to issue #${expectedIssue} — refusing a mismatched closing reference (pass --allow-cross-issue to record a deliberate cross-issue reference)`;
  }
  return null;
}
