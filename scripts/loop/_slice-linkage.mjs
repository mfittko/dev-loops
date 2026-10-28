// SPEC-SLICE-PR-KEEPS-CLOSING-REF: the slice-PR linkage rule, shared by the spec context, the judge work order and the judge pass.
import { resolvePrDescriptionSpec } from "@dev-loops/core/loop/spec-authority";

export const SLICE_LINKAGE_RULE_ID = "SPEC-SLICE-PR-KEEPS-CLOSING-REF";
export const SLICE_LINKAGE_SENTENCE = `${SLICE_LINKAGE_RULE_ID}: a slice PR keeps its closing reference (Closes #N) and its Non-goals reopen line; changing Closes to Refs is never a remedy, because a Refs-only slice PR has no spec authority today. This rule is interim until Refs-only pr_body authority ships in a later slice of issue 2883, and the Refs plus verbatim slice body shape (dod:3) stays open.`;

// A Non-goals entry that says an issue is reopened marks a slice PR: a reopen inflection and an issue number (#N, issue N or a bare number of 3+ digits) on one line.
// A negated reopen ("Do not reopen ...") and a bare number after "ADR" are not reopen lines.
export const hasReopenLine = (nonGoals) => Array.isArray(nonGoals)
  && nonGoals.some((line) => {
    const text = String(line);
    return /\bre-?open(?:s|ed|ing)?\b/i.test(text) && !/\b(?:do\s+not|don't|never|not|cannot|can't)\s+re-?open/i.test(text) && /#\d+|\bissues?\s+\d+|(?<!\bADR\s)\b\d{3,}\b/i.test(text);
  });

// The Non-goals of a PR body; the reopen line lives there when the spec comes from the linked issue.
export const prBodyNonGoals = (body) => resolvePrDescriptionSpec(String(body ?? "")).spec?.nonGoals;

const KW = String.raw`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)`;
// An issue reference: N, #N, owner/repo#N or an issue URL; the number is capture group 1 of its pattern.
const REF = String.raw`(?:https?://github\.com/[\w.-]+/[\w.-]+/issues/|[\w.-]+/[\w.-]+#|#)?(\d+)\b`;
const CLOSING = String.raw`\b${KW}\b(?:\s+${REF})?`;
const OPT_REF = String.raw`(?:\s+${REF})?`;
// Closes [N], then a swap connector, then Refs [N]: the numbers (groups 1 and 2) must be equal, both absent counts as equal.
const CLOSING_THEN_REFS = new RegExp(String.raw`${CLOSING}[^\n]*?(?:\bwith\b|\bto\b|\bby\b|\bfor\b|\bbecomes\b|\binto\b|->|→)[^\n]*?\brefs?\b${OPT_REF}`, "gi");
// Refs [N] instead of Closes [N]: group 1 is the Refs number, group 2 the Closes number.
const REFS_INSTEAD_OF_CLOSING = new RegExp(String.raw`\brefs?\b${OPT_REF}[^\n]*?\binstead\s+of\b[^\n]*?${CLOSING}`, "gi");
// A removal verb on a closing reference.
const REMOVES_CLOSING = new RegExp(String.raw`\b(?:remove|drop|delete|strip)\s+(?:the\s+)?${KW}\b${OPT_REF}`, "gi");
// A number-less swap counts only in the PR reference forms (Closes/Fixes/Resolves and Refs, capitalized); "Resolve the path relative to the base ref" is a code fix.
const PR_KEYWORD = /\b(?:Closes|Fixes|Resolves)\b/;
const SAME_NUMBER = (m) => m[1] === m[2] && (m[1] !== undefined || (PR_KEYWORD.test(m[0]) && /\bRefs\b/.test(m[0])));

// A negation that directly governs the remedy verb ("Do not change Closes to Refs") or a keep that directly governs the closing reference ("Keep Closes 10") ends the prefix.
// An unrelated keep or negation earlier in the clause ("Never mind the nit, change ...", "To keep the parent open, replace ...") does not.
const VERB = String.raw`(?:remove|drop|delete|strip|change|replace|swap|switch|convert|use|write|put|turn|rewrite)`;
const GOVERNED = new RegExp(String.raw`(?:\b(?:do\s+not|don't|never|must\s+not|should\s+not|shouldn't)\s+(?:${VERB}\s+)?(?:the\s+)?|\bkeep\s+(?:the\s+)?)$`, "i");

// True when the judged remedy (judgeFix only, never the reviewer recommendation) removes a closing reference.
export const removesClosingRef = (finding) => {
  if (typeof finding?.judgeFix !== "string") return false;
  // A clause whose remedy is directly negated ("Do not remove the Closes #10 line") restates the rule and is skipped.
  // A keep or negation after the remedy is its reason ("Replace Closes #10 with Refs #10 to keep the parent open") and does not skip it.
  return finding.judgeFix.replace(/[`*]/g, "").split(/[;\n]|\.(?:\s|$)/).some((clause) => [
    [CLOSING_THEN_REFS, SAME_NUMBER], [REFS_INSTEAD_OF_CLOSING, SAME_NUMBER], [REMOVES_CLOSING, (m) => m[1] !== undefined || PR_KEYWORD.test(m[0])],
  ].some(([re, accepts]) => [...clause.matchAll(re)].some((m) => accepts(m) && !GOVERNED.test(clause.slice(0, m.index)))));
};

// Coerce an act finding whose judged remedy removes a closing reference to reject; returns the number coerced.
// The caller passes the Non-goals of the --spec-file, or `true` when the pinned judge work order already carries sliceLinkage.
export function rejectClosingRefRemoval(enriched, ...armedBy) {
  if (!armedBy.some((source) => source === true || hasReopenLine(source))) return 0;
  let coerced = 0;
  for (const f of enriched) {
    if (f.judgeDisposition !== "act" || !removesClosingRef(f)) continue;
    f.judgeDisposition = "reject";
    f.judgeReason = [`SPEC-SLICE-PR-KEEPS-CLOSING-REF: refused, the remedy removes a closing reference while a Non-goals reopen line is present.`, f.judgeReason].filter(Boolean).join(" ");
    coerced += 1;
  }
  return coerced;
}
