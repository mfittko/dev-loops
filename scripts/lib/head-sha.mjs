// Shared head-SHA validation for gate-evidence tooling.
//
// The findings-log ledger path and the gate-review comment marker are both keyed
// by the head SHA verbatim. The pre-merge reader (detect-checkpoint-evidence)
// resolves the head via `gh pr view --json headRefOid`, which is always the FULL
// commit SHA, and both builds the ledger lookup path from it and compares the
// marker head SHA to it by equality. So a writer that accepts a short/prefix SHA
// silently produces an unfindable ledger and a never-current marker. Writers of
// the path/marker key must therefore require the full SHA and fail closed.
//
// GitHub commit OIDs are 40-hex SHA-1; 64-hex SHA-2 is accepted for forward
// compatibility. Provenance-only fields (carriedFromHead, resolvedIn) stay a
// 7-64 prefix — they are recorded values, not path/marker keys.

/**
 * Normalize a full head SHA. Returns the lowercased 40- or 64-hex SHA, or null
 * if the value is not a full-length hex SHA (a short prefix returns null).
 */
export function normalizeFullHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized) ? normalized : null;
}

export const FULL_HEAD_SHA_ERROR =
  "--head-sha must be the FULL head commit SHA (40 or 64 hex chars), not a short prefix — " +
  "the findings-log ledger path and gate marker are keyed by it and the pre-merge check " +
  "resolves the full head SHA, so a prefix writes an unfindable ledger";

/**
 * Fetch the PR head ref oid via `gh pr view --json headRefOid`.
 *
 * Shared by gate-evidence tooling that needs the current head to stamp a
 * verdict or audit which surface carries it. Centralizing the head-oid read
 * avoids hand-rolled copies drifting on case-normalization / error handling
 * (issue #1729 pre-approval dry finding). Returns the lowercased full oid.
 */
export async function fetchPrHeadRefOid({ repo, pr }, { env = process.env, ghCommand = "gh", runChild }) {
  if (typeof runChild !== "function") {
    throw new Error("fetchPrHeadRefOid requires a runChild dispatch");
  }
  const res = await runChild(ghCommand, ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"], env);
  if (res.code !== 0) {
    throw new Error(`gh pr view failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout.trim());
  } catch (e) {
    throw new Error(`Invalid JSON from gh pr view: ${e.message}`);
  }
  const head = typeof payload?.headRefOid === "string" && payload.headRefOid.trim().length > 0
    ? payload.headRefOid.trim().toLowerCase()
    : null;
  if (!head) throw new Error("gh pr view returned no headRefOid");
  return head;
}
