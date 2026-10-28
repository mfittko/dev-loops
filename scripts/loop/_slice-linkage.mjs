// SPEC-SLICE-PR-KEEPS-CLOSING-REF: the slice-PR linkage rule, shared by the spec context and the judge pass.
export const SLICE_LINKAGE_RULE_ID = "SPEC-SLICE-PR-KEEPS-CLOSING-REF";
export const SLICE_LINKAGE_SENTENCE = `${SLICE_LINKAGE_RULE_ID}: a slice PR keeps its closing reference (Closes #N) and its Non-goals reopen line; changing Closes to Refs is never a remedy, because a Refs-only slice PR has no spec authority.`;

// A Non-goals entry that says the issue is reopened marks a slice PR.
export const hasReopenLine = (nonGoals) => Array.isArray(nonGoals) && nonGoals.some((line) => /\breopen\s+#\d+/i.test(String(line)));

const CLOSING_THEN_REFS = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#\d+[^\n]*?\b(?:with|to|by|instead|->|→)\W[^\n]*?\brefs?\s+#\d+/i;

// True when a finding's judged remedy swaps a closing reference for a Refs reference.
export const removesClosingRef = (finding) => {
  const text = [finding?.judgeFix, finding?.judgeDetail, finding?.recommendation].filter((t) => typeof t === "string").join("\n");
  return CLOSING_THEN_REFS.test(text);
};

// Coerce an act finding that removes the PR's closing reference to reject; returns the number coerced.
export function rejectClosingRefRemoval(enriched, nonGoals) {
  if (!hasReopenLine(nonGoals)) return 0;
  let coerced = 0;
  for (const f of enriched) {
    if (f.judgeDisposition !== "act" || !removesClosingRef(f)) continue;
    f.judgeDisposition = "reject";
    f.judgeReason = `${SLICE_LINKAGE_RULE_ID}: the remedy removes the PR's closing reference while a Non-goals reopen line is present. ${f.judgeReason ?? ""}`.trim();
    coerced += 1;
  }
  return coerced;
}
