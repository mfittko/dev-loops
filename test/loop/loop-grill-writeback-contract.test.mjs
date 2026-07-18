import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectIssueRefinementArtifact } from "@dev-loops/core/loop/issue-refinement-artifact";

const skill = readFileSync(fileURLToPath(new URL("../../skills/loop-grill/SKILL.md", import.meta.url)), "utf8");
const commandDoc = readFileSync(fileURLToPath(new URL("../../commands/loop-grill.command.md", import.meta.url)), "utf8");
const stateGraphDoc = readFileSync(
  fileURLToPath(new URL("../../docs/refinement-grill-state-graph.md", import.meta.url)),
  "utf8",
);

// Proxy detectors for the three write-back hygiene RULES the SKILL.md contract
// describes in prose — the contract states the rules narratively, not as regexes,
// so these are the test's own approximations, used to prove the fixtures below
// actually exercise each rule rather than only pinning doc text. Not a production
// module: the grill itself is agent-executed prose. The unresolved-option proxy
// uses the dotAll (`s`) flag so "Suggested: … or …" split across a markdown list
// (newlines) still trips it.
const RATIONALE_SECTION_RE = /^#{1,6}\s*(?:🔬\s*)?(?:refinement notes|grill findings|grill\s*\/\s*refinement results)\b/im;
const UNRESOLVED_OPTION_RE = /\bsuggested:.*\bor\b|\boption a or b\b/is;
const BARE_NON_ISSUE_HASH_RE = /(?<![\w`])#\d+(?!\d)/;

function assertWriteBackClean(body) {
  assert.doesNotMatch(body, RATIONALE_SECTION_RE, "post-grill description must carry no rationale/narrative section");
  assert.doesNotMatch(body, UNRESOLVED_OPTION_RE, "post-grill description must carry no unresolved 'suggested ... or ...' option");
  assert.doesNotMatch(body, BARE_NON_ISSUE_HASH_RE, "post-grill description must carry no bare non-issue #N");
}

test("SKILL.md write-back contract names all three rewrite rules and the new rule IDs", () => {
  assert.match(skill, /GRILL-SUBLOOP-FULL-REWRITE/);
  assert.match(skill, /GRILL-SUBLOOP-RATIONALE-COMMENT/);
  assert.match(skill, /GRILL-SUBLOOP-NO-BARE-HASH/);
  assert.match(skill, /full rewrite, not an? append/i);
  assert.match(skill, /Refinement notes.*Grill findings.*rationale narrative/i);
  assert.match(skill, /suggested \/ option A or B \/ TBD/i);
  assert.match(skill, /rewrite as `defect N` \/ `item N` \/ backticks/i);
  assert.match(skill, /🔬 Grill \/ refinement results/);
  assert.match(skill, /never `gh issue comment` directly/i);
});

test("SKILL.md verdict step verifies the write-back contract and fails closed", () => {
  const verdictSection = skill.split("## Step 5 — Emit verdict")[1] ?? "";
  assert.match(verdictSection, /fail closed if any check fails/i);
  assert.match(verdictSection, /no `Refinement notes` \/ `Grill findings` \/ rationale narrative section/i);
  assert.match(verdictSection, /no unresolved "suggested … or …" \/ "option A or B" marker/i);
  assert.match(verdictSection, /bare non-issue `#<number>`/i);
  assert.match(verdictSection, /A `🔬 Grill \/ refinement results` comment was actually posted/i);
});

test("command doc documents the deterministic edit-then-comment split and its fail-closed verification", () => {
  assert.match(commandDoc, /dev-loops issue edit --repo <owner\/repo> --issue <n> --body-file <tmp-body-path>/);
  assert.match(commandDoc, /node scripts\/github\/comment-issue\.mjs --repo <owner\/repo> --issue <n> --body-file <tmp-rationale-path>/);
  assert.match(commandDoc, /🔬 Grill \/ refinement results/);
  assert.match(commandDoc, /fails closed/i);
});

test("the three new rule IDs are defined exactly once, in the state graph doc", () => {
  for (const id of ["GRILL-SUBLOOP-FULL-REWRITE", "GRILL-SUBLOOP-RATIONALE-COMMENT", "GRILL-SUBLOOP-NO-BARE-HASH"]) {
    const markerCount = (stateGraphDoc.match(new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`, "g")) ?? []).length;
    assert.equal(markerCount, 1, `${id} must be defined exactly once in docs/refinement-grill-state-graph.md`);
  }
});

test("a fully-rewritten post-grill description passes the write-back hygiene checks and still trips detectIssueRefinementArtifact", () => {
  const rewrittenBody = [
    "## Problem",
    "",
    "The gate comment truncates long failure reasons without a documented limit.",
    "",
    "## Proposed change",
    "",
    "Cap the reason with `MAX_GATE_COMMENT_TEXT_LENGTH`; reasons longer than that are truncated with a trailing ellipsis.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Reasons longer than `MAX_GATE_COMMENT_TEXT_LENGTH` are truncated with a trailing ellipsis",
    "- [ ] Reasons at or under the limit are left untouched",
    "",
    "## Definition of done",
    "",
    "- [ ] `npm run verify` green",
    "",
    "## Non-goals",
    "",
    "- Changing the limit value itself — only enforcing it",
  ].join("\n");

  assertWriteBackClean(rewrittenBody);

  const artifact = detectIssueRefinementArtifact({ body: rewrittenBody });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.finding, null);
});

test("a description still carrying the pre-grill defects (rationale section, unresolved option, bare #N) fails the hygiene checks", () => {
  const unfixedBody = [
    "## Problem",
    "",
    "The gate comment truncates long failure reasons without a documented limit.",
    "",
    "Suggested: cap the reason with MAX_GATE_COMMENT_TEXT_LENGTH (or a dedicated ~300-char limit), or fail closed instead.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Reasons are capped at a documented limit",
    "",
    "## Refinement notes (auto)",
    "",
    "Considered defect #1 (truncation) and defect #2 (fail-closed); recommend truncation.",
  ].join("\n");

  assert.throws(() => assertWriteBackClean(unfixedBody), /rationale\/narrative section|unresolved 'suggested/);
});

test("results-comment fixture carries the required title and no bare non-issue #N", () => {
  const resultsComment = [
    "## 🔬 Grill / refinement results",
    "",
    "### Gaps found and filled",
    "",
    "- Missing documented truncation limit — filled from `MAX_GATE_COMMENT_TEXT_LENGTH`.",
    "",
    "### Recommendation and rejected alternatives",
    "",
    "Recommended: cap with `MAX_GATE_COMMENT_TEXT_LENGTH`. Rejected: a dedicated ~300-char limit (defect A) and fail-closed on overflow (defect B) — both add a second knob for no measured benefit.",
  ].join("\n");

  assert.match(resultsComment, /🔬 Grill \/ refinement results/);
  assert.doesNotMatch(resultsComment, BARE_NON_ISSUE_HASH_RE, "results comment must carry no bare non-issue #N");
});

test("each write-back hygiene detector independently fires on its own defect (non-vacuous)", () => {
  // assertWriteBackClean short-circuits on the first failing assert, so the
  // unfixed-body test only proves RATIONALE_SECTION_RE rejects. Pin each of the
  // other two detectors directly so a silently-broken regex (one that never
  // matches) can't leave every fixture green.
  assert.match("## Refinement notes (auto)", RATIONALE_SECTION_RE);
  assert.match("Suggested: cap it here, or fail closed instead.", UNRESOLVED_OPTION_RE);
  assert.match("Considered defect #1 (truncation).", BARE_NON_ISSUE_HASH_RE);
  // And the bare-#N detector must NOT trip on a backticked genuine issue ref.
  assert.doesNotMatch("tracked in `#1389`", BARE_NON_ISSUE_HASH_RE);
});
