// SPEC-SLICE-PR-KEEPS-CLOSING-REF: the slice-PR linkage rule, shared by the spec context, the judge work order and the judge pass.
import { resolvePrDescriptionSpec } from "@dev-loops/core/loop/spec-authority";

export const SLICE_LINKAGE_RULE_ID = "SPEC-SLICE-PR-KEEPS-CLOSING-REF";
export const SLICE_LINKAGE_SENTENCE = `${SLICE_LINKAGE_RULE_ID}: a slice PR keeps its closing reference (Closes #N) and its Non-goals reopen line; changing Closes to Refs is never a remedy, because a Refs-only slice PR has no spec authority today. This rule is interim until Refs-only pr_body authority ships in a later slice of issue 2883, and the Refs plus verbatim slice body shape (dod:3) stays open.`;

// A Non-goals entry that says an issue is reopened marks a slice PR: a reopen inflection and an issue number (#N, issue N or a bare number of 3+ digits) on one line.
// A negated reopen ("Do not reopen ...") and a bare number after "ADR" are not reopen lines.
export const hasReopenLine = (nonGoals) => Array.isArray(nonGoals)
  && nonGoals.some((line) => {
    const text = String(line);
    return /\breopen(?:s|ed|ing)?\b/i.test(text) && !/\b(?:do\s+not|don't|never|not)\s+reopen/i.test(text) && /#\d+|\bissues?\s+\d+|(?<!\bADR\s)\b\d{3,}\b/i.test(text);
  });

// The Non-goals of a PR body; the reopen line lives there when the spec comes from the linked issue.
export const prBodyNonGoals = (body) => resolvePrDescriptionSpec(String(body ?? "")).spec?.nonGoals;

const CLOSING = String.raw`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#?(\d+)\b`;
// Closes N, then a swap connector, then Refs for the same N.
const CLOSING_THEN_REFS = new RegExp(String.raw`\b${CLOSING}[^\n]*?(?:\bwith\b|\bto\b|\bby\b|\bfor\b|->|→)[^\n]*?\brefs?\s+#?\1\b`, "i");
// Refs N instead of Closes N.
const REFS_INSTEAD_OF_CLOSING = new RegExp(String.raw`\brefs?\s+#?(\d+)\b[^\n]*?\binstead\s+of\b[^\n]*?\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#?\1\b`, "i");
// A removal verb on a closing reference.
const REMOVES_CLOSING = new RegExp(String.raw`\b(?:remove|drop|delete|strip)\s+(?:the\s+)?${CLOSING}`, "i");

const KEEPS_CLOSING = /\b(?:do\s+not|don't|never|must\s+not|keep)\b/i;

// True when the judged remedy (judgeFix only, never the reviewer recommendation) removes a closing reference.
export const removesClosingRef = (finding) => {
  if (typeof finding?.judgeFix !== "string") return false;
  // A clause that keeps or negates ("Keep Closes #10; do not change it to Refs #10") restates the rule and is skipped.
  return finding.judgeFix.replace(/[`*]/g, "").split(/[;\n]|\.(?:\s|$)/).some((clause) => !KEEPS_CLOSING.test(clause)
    && (CLOSING_THEN_REFS.test(clause) || REFS_INSTEAD_OF_CLOSING.test(clause) || REMOVES_CLOSING.test(clause)));
};

// Coerce an act finding whose judged remedy removes a closing reference to reject; returns the number coerced.
// The caller passes the Non-goals of the --spec-file and of the PR body.
export function rejectClosingRefRemoval(enriched, ...nonGoalLists) {
  if (!nonGoalLists.some(hasReopenLine)) return 0;
  let coerced = 0;
  for (const f of enriched) {
    if (f.judgeDisposition !== "act" || !removesClosingRef(f)) continue;
    f.judgeDisposition = "reject";
    f.judgeReason = [`SPEC-SLICE-PR-KEEPS-CLOSING-REF: refused, the remedy removes a closing reference while a Non-goals reopen line is present.`, f.judgeReason].filter(Boolean).join(" ");
    coerced += 1;
  }
  return coerced;
}
