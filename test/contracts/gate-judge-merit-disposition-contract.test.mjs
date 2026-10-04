// Conformance guard for issue #2306: the first-round gate must not auto-defer a
// finding on its severity label. The judge/reviewer pipeline is LLM-driven, so
// the durable fix is the briefing contract prose — these tests fail closed if
// the severity-based auto-defer for lows reappears, or if the internal reviewer
// severity calibration rule is dropped. See ADR 0078 (amends ADR 0051).
//
// Assertions key on 2-3 load-bearing tokens with bounded gaps (not whole
// sentences), so a semantics-preserving rewording does not falsely break them,
// while the negative guards below fail closed if the exact old auto-defer
// sentence is re-added alongside the new prose.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFile(`${repoRoot}${rel}`, "utf8");

// The exact pre-#2306 auto-defer sentence, in both the judge.agent.md and the
// Phase 3.5 spellings ("A `low` is deferred only when ..." / "`low` MUST be
// deferred only when ..."). Its return — even beside the new prose — is the
// regression this issue exists to prevent.
const OLD_AUTODEFER_RE = /`low`\s+(?:is|MUST be)\s+deferred only when/;

// Structural claim check. A claim is a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities)
// that must co-occur in ONE sentence of the located block, so rewording keeps passing and a dropped literal
// or modality fails. `assertClaims` also proves both directions on the real block: a reworded copy (filler clause between tokens, sentence order reversed) passes,
// and removing a claim's last token makes exactly that claim fail.
const collapse = (text) => text.replace(/\s+/g, " ");
const sentences = (text) => collapse(text).split(/(?<=[.!?:])\s+(?=[A-Z`*(|-])/);
const missingClaims = (block, claims) => claims.filter((tokens) => !sentences(block).some((s) => tokens.every((t) => s.includes(t))));
const reword = (block, claims) => sentences(block).map((s) => (claims.find((tokens) => tokens.every((t) => s.includes(t)))?.slice(0, -1) ?? []).reduce((acc, t) => acc.replace(t, `${t} (as the contract records, without exception)`), s)).reverse().join(" ");
function assertClaims(block, claims, label) {
  assert.deepEqual(missingClaims(block, claims), [], `${label}: missing claim`);
  assert.deepEqual(missingClaims(reword(block, claims), claims), [], `${label}: a reworded copy must pass`);
  for (const tokens of claims) {
    const broken = collapse(block).split(tokens.at(-1)).join("");
    assert.ok(missingClaims(broken, claims).includes(tokens), `${label}: dropping ${tokens.at(-1)} must fail ${tokens.join(" + ")}`);
  }
}

// --- Disposition half (AC1/AC2): severity is an input, not an auto-gate ---

test("agents/judge.agent.md states severity is an INPUT and a real defect (incl. a low) is act regardless of its label", async () => {
  const text = await read("agents/judge.agent.md");
  assert.match(text, /Severity is an INPUT[\s\S]{0,60}never an auto-gate/, "judge contract must state severity is an INPUT, never an auto-gate");
  assert.match(text, /regardless of its severity label[\s\S]{0,40}`low`/, "judge contract must state a real defect is act regardless of its label, including a low");
  assert.doesNotMatch(text, OLD_AUTODEFER_RE, "judge contract must NOT re-introduce the severity-based auto-defer sentence for lows");
});

test("agents/judge.agent.md keeps the net-reduction bar: a real AC-relevant low is act, a cosmetic low still rejects", async () => {
  const text = await read("agents/judge.agent.md");
  // The act path for a real low must be explicit (fails if reverted to defer/reject-only).
  assert.match(text, /genuine AC-relevant defect is `act`[\s\S]{0,120}never deferred or rejected on its severity label/, "a genuine AC-relevant low must be act, never deferred/rejected on its label");
  // AC2: a genuinely cosmetic low is still rejected (net-reduction preserved).
  assert.match(text, /cosmetic `low`[\s\S]{0,60}defaults to `reject`/, "a genuinely cosmetic low must still default to reject (net-reduction)");
});

test("the Phase 3.5 judge contract states no severity auto-defer and adjudicates every finding on merits", async () => {
  const text = await read("skills/docs/gate-review-sub-loop-contract.md");
  const section = parseMarkdownSections(text).find(({ bodyLines }) =>
    bodyLines.includes("<!-- rule: GATE-EXEC-JUDGE-PHASE -->"));
  assert.ok(section, "expected the GATE-EXEC-JUDGE-PHASE section");
  const body = section.bodyLines.join("\n");
  assertClaims(body, [
    ["Severity is an INPUT", "never an auto-gate"],
    ["EVERY finding", "`low`", "merits"],
    ["real defect", "`act`", "severity label"],
    ["cosmetic `low`", "defaults to", "`reject`"],
  ], "Phase 3.5 merit disposition");
  assert.doesNotMatch(body, OLD_AUTODEFER_RE, "Phase 3.5 must NOT re-introduce the severity-based auto-defer sentence for lows");
});

// A sentence that grants a low finding a defer "from round 1" must carry the judge-acted-low exception
// (a judge `act` low is declinable on reproduction grounds only), so no allowance site re-defers it downstream.
const lowDeferGrants = (text) => sentences(text).filter((s) => /from round 1/i.test(s) && /\blow\b/i.test(s) && /defer/i.test(s));
const unexemptedGrants = (text) => lowDeferGrants(text).filter((s) => !(s.includes("`act`") && s.includes("reproduction")));

test("EVERY round-1 low-defer allowance in the sub-loop contract exempts a judge-acted low (no downstream re-defer)", async () => {
  const text = await read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(lowDeferGrants(text).length >= 1, "expected at least one round-1 low-defer allowance");
  assert.deepEqual(unexemptedGrants(text), []);
  // Reworded positive: the exception travels with the allowance in any phrasing.
  assert.deepEqual(unexemptedGrants("A low may be deferred from round 1, unless the judge marked it `act`; the fixer then declines only on reproduction grounds."), []);
  // Broken negative: an allowance without the exception is reported.
  assert.equal(unexemptedGrants("A low may be deferred from round 1 with no fix window.").length, 1);
  // Case-insensitive: a capitalized grant is still caught.
  assert.equal(unexemptedGrants("Defer is permitted From Round 1 for Low findings.").length, 1);
});

test("the operational fixer instructions exempt a judge-acted low from the round-1 defer allowance", async () => {
  // The sub-loop contract carve-out is not enough: a conductor follows the
  // copilot-pr-followup SKILL's own fixer instructions, which must carry the
  // same judge-acted-low exception or the downstream re-defer leak reopens there.
  const text = await read("skills/copilot-pr-followup/SKILL.md");
  const matches = text.match(/low the judge disposed `act`[\s\S]{0,140}reproduction grounds/g) ?? [];
  assert.ok(matches.length >= 2, `both fixer-instruction sites (classify-findings + Phase 5 triage) must exempt a judge-acted low as a reproduction-only-declinable fix target (found ${matches.length})`);
});

// --- Calibration half (AC3): a real correctness/fail-open is not labeled low ---

test("the sub-loop contract severity classification calibrates a real correctness/fail-open defect to at least medium", async () => {
  const text = await read("skills/docs/gate-review-sub-loop-contract.md");
  assertClaims(text, [["CONSEQUENCE", "correctness", "reachable path", "at least `medium`", "never `low`"]], "contract severity calibration");
});

test("agents/review.agent.md applies the severity calibration so reviewers do not under-label a real defect as low", async () => {
  const text = await read("agents/review.agent.md");
  assertClaims(text, [
    ["consequence", "correctness break", "at least `medium`", "never `low`"],
    ["`low`", "no operator-visible consequence"],
  ], "reviewer agent severity calibration");
});

// --- ADR provenance: the amendment is recorded, 0051's body is untouched ---

test("ADR 0078 records the merit-disposition + calibration decision and amends ADR 0051", async () => {
  const adr = await read("docs/decisions/0078-judge-adjudicates-every-finding-on-merits.md");
  assert.match(adr, /^Amends \[ADR 0051\]/m, "ADR 0078 must declare it amends ADR 0051");
  assert.match(adr, /Severity is an INPUT to the judge, never an auto-gate/, "ADR 0078 must record the merit-disposition decision");
});
