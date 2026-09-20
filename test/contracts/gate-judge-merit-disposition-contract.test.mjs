// Conformance guard for issue #2306: the first-round gate must not auto-defer a
// finding on its severity label. The judge/reviewer pipeline is LLM-driven, so
// the durable fix is the briefing contract prose — these tests fail closed if
// the severity-based auto-defer for lows reappears, or if the internal reviewer
// severity calibration rule is dropped. See ADR 0077 (amends ADR 0051).
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
  assert.match(body, /Severity is an INPUT[\s\S]{0,40}never an auto-gate/, "Phase 3.5 must state severity is an input, never an auto-gate");
  assert.match(body, /EVERY finding[\s\S]{0,40}`low`[\s\S]{0,40}merits/, "Phase 3.5 must state every finding incl. lows is adjudicated on merits");
  assert.match(body, /real defect[\s\S]{0,20}`act` regardless of its severity label/, "Phase 3.5 must state a real defect is act regardless of severity label");
  // AC2 preserved in the same contract.
  assert.match(body, /cosmetic `low`[\s\S]{0,40}defaults to[\s\S]{0,4}`reject`/, "Phase 3.5 must keep a cosmetic low defaulting to reject");
  assert.doesNotMatch(body, OLD_AUTODEFER_RE, "Phase 3.5 must NOT re-introduce the severity-based auto-defer sentence for lows");
});

test("the severity-axis fixer-triage rule exempts a judge-acted low from the round-1 defer allowance (no downstream re-defer)", async () => {
  // Without this, the judge acts a real low but the fixer may still triage-defer
  // it on cheapness — moving the severity-label defer one stage downstream.
  const text = await read("skills/docs/gate-review-sub-loop-contract.md");
  const matches = text.match(/low the (?:JUDGE|judge)[\s\S]{0,80}disposed `act`[\s\S]{0,160}reproduction grounds/g) ?? [];
  assert.ok(matches.length >= 2, `both "Defer is permitted from round 1 for lows" sites must exempt a judge-acted low as a reproduction-only-declinable fix target (found ${matches.length})`);
});

// --- Calibration half (AC3): a real correctness/fail-open is not labeled low ---

test("the sub-loop contract severity classification calibrates a real correctness/fail-open defect to at least medium", async () => {
  const text = await read("skills/docs/gate-review-sub-loop-contract.md");
  assert.match(text, /Calibrate severity to[\s\S]{0,20}CONSEQUENCE/, "the classification bullet must carry the consequence-not-size calibration rule");
  assert.match(text, /correctness on a reachable path[\s\S]{0,80}at least `medium`[\s\S]{0,12}never `low`/, "the calibration must rate a correctness/fail-open defect at least medium, never low");
});

test("agents/review.agent.md applies the severity calibration so reviewers do not under-label a real defect as low", async () => {
  const text = await read("agents/review.agent.md");
  assert.match(text, /Calibrate the label to consequence/, "the reviewer agent must apply the calibration at point-of-action");
  assert.match(text, /at least `medium`, never `low`[\s\S]{0,80}no operator-visible consequence/, "the reviewer agent must reserve low for a defect with no operator-visible consequence");
});

// --- ADR provenance: the amendment is recorded, 0051's body is untouched ---

test("ADR 0077 records the merit-disposition + calibration decision and amends ADR 0051", async () => {
  const adr = await read("docs/decisions/0077-judge-adjudicates-every-finding-on-merits.md");
  assert.match(adr, /^Amends \[ADR 0051\]/m, "ADR 0077 must declare it amends ADR 0051");
  assert.match(adr, /Severity is an INPUT to the judge, never an auto-gate/, "ADR 0077 must record the merit-disposition decision");
});
