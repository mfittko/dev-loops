import { access } from "node:fs/promises";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

import {
  assert,
  assertMatchesAll,
  fromRepoRoot,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";

// ---------------------------------------------------------------------------
// Angle carry-forward is a fail-closed decision seam with a CLI, a surface map,
// and a provenance shape — all of it inert unless an operational procedure step
// actually routes to it. Before this guard, the rule lived only in the contract
// doc, so every gate round re-dispatched every angle and the seam was never
// invoked once.
//
// These assertions pin the ROUTING in place: the skill that drives the fan-out
// must name the CLI, dispatch only the angles it leaves to re-run, record the
// carried ones with their carried provenance, and treat a CLI refusal as
// "re-run everything" rather than "re-run nothing". Each pattern group is
// matched against the SPECIFIC numbered step it governs (extracted by its
// heading), not the whole file — a bare header/Phase-3 mention of a token like
// `carriedFromHead` must not satisfy a check that exists to pin Phase 1.2.
// ---------------------------------------------------------------------------

const SKILL = "skills/copilot-pr-followup/SKILL.md";
const SUB_LOOP_CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";

// Every source skill that drives a gate retry. The bare "only the angles that
// had findings" rule must survive in none of them. The sub-loop contract owns
// GATE-EXEC-ANGLE-CARRY-FORWARD itself, and every AC4 sentence lands there, so
// it is in scope for this guard too. Generated .claude mirrors are not listed:
// claude-assets-reproducible.test.mjs proves the mirror is byte-reproducible
// from these sources, so a rule absent from the source is absent from the mirror.
const GATE_DRIVING_SKILLS = [
  SKILL,
  "skills/local-implementation/SKILL.md",
  SUB_LOOP_CONTRACT,
];

// Include wrapped paragraphs, but never borrow a command from a sibling step
// or the following section. Heading wording is not used to find the boundary.
function extractStep(content, heading, file) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^\d+\. /.test(line) && line.replace(/^\d+\. /, "").startsWith(heading));
  assert.ok(start >= 0, `${file}: expected to find the ${JSON.stringify(heading)} step`);
  const end = lines.findIndex((line, index) => index > start && /^(?:\d+\. |#{1,6} )/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

// Phase 1.2 must invoke the real resolver with bound head/spec identities and
// load its owner. Eligibility, refusal, subtraction and provenance behavior
// are covered by resolver/emitter/fan-in tests; prose preservation needs
// independent semantic review, not an exact sentence masquerading as proof.
const PHASE_1_2_ROUTING = [
  // Keep both identities bound to the resolver invocation, not a sibling
  // command. Full-SHA acceptance/refusal is tested against its actual parser
  // in resolve-angle-carry-forward.test.mjs, not an incidental prose phrase.
  /`[^`]*resolve-angle-carry-forward\.mjs[^`]*--prev-head\s+<prior_head_sha>[^`]*--head-sha\s+<current_head_sha>[^`]*--spec-authority\s+<identity-path>[^`]*`/,
  // The rule itself stays owned by the contract doc.
  /GATE-EXEC-ANGLE-CARRY-FORWARD/,
];

// Phase 2 routes carry-forward through the pending emitter API. The actual
// subtraction is exercised end-to-end in emit-fanout-dispatch.test.mjs;
// prose meaning is reviewed in the linked owner, not inferred from keywords.
const PHASE_2_ROUTING = [
  /`[^`]*emit-fanout-dispatch\.mjs[^`]*--pending[^`]*`/,
  /`[^`]*--carried-angles[^`]*--prev-head[^`]*`/,
];

// Phase 3 (Fan-in): --provenance belongs to the LEDGER WRITE, not the comment
// post — pinned on this line specifically so a reworded sentence that reattaches
// the flag to the wrong command (the exact defect this pins) fails here. The
// step may span paragraphs; anchor inside the backtick-delimited code span
// (`[^`]*`), which stops at the first closing backtick and so cannot reach past
// the ledger-write command into a later, separately-quoted mention.
const PHASE_3_ROUTING = [
  /write-gate-findings-log\.mjs[^`]*--provenance/,
  /carriedFromHead/,
];
// --provenance must NOT be reachable, within one code span, from the comment-post
// command — this is the exact defect round 3 fixed and pins it from reintroduction.
const PHASE_3_PROVENANCE_NOT_ON_COMMENT_POST = /post-gate-findings\.mjs[^`]*--provenance/;

// The class of banned rule this PR removed: "re-run only ... (findings |
// findings_present) ... previous pass/head/round". Broad enough to catch a
// reworded reintroduction of the SAME scoping rule, not just the one literal
// phrasing this PR happened to delete — a reviewer who restores the removed
// sentence verbatim, or rewords it (e.g. "in subsequent cycles, re-run only the
// angles that had findings in the previous pass"), must still be caught.
const BARE_FINDINGS_ONLY_RERUN_CLASS =
  /\bonly\b[^.\n]{0,80}\b(?:findings_present|findings)\b[^.\n]{0,60}\bprevious\s+(?:pass|head|round)\b/i;

test("copilot-pr-followup SKILL's Phase 1.2 step routes the fan-out through resolve-angle-carry-forward", async () => {
  const skill = await readRepo(SKILL);
  const line = extractStep(skill, "**Carry-forward (Phase 1.2):**", SKILL);
  assertMatchesAll(line, PHASE_1_2_ROUTING, `${SKILL} Phase 1.2 step`);
  assert.ok(extractRelativeMarkdownLinks(line).some(({ rawTarget }) => rawTarget === "../docs/gate-review-sub-loop-contract.md#angle-carry-forward-fail-closed"));
  assertRuleOwned("GATE-EXEC-ANGLE-CARRY-FORWARD", SUB_LOOP_CONTRACT);
});

test("carry routing binds both head arguments to the resolver through prose rewrites", async () => {
  const step = extractStep(await readRepo(SKILL), "**Carry-forward (Phase 1.2):**", SKILL);
  const reworded = step
    .replace("Use FULL 40-character SHAs", "Supply full commit identities")
    .replace("subtract, never substitute", "use set subtraction")
    .replace("minus the plan's `carried` angles", "except angles proven carried by the plan")
    .replace("never a fabricated fresh review", "without inventing a new reviewer")
    .replace("Skip this step on a gate's first round", "A first round has no carry-forward step")
    .replace('never treat exit 1 as "nothing to re-run"', "exit 1 requires full fan-out");
  for (const rewritten of [step, reworded, reworded.replace(/\. /g, ".\n   ")]) {
    assertMatchesAll(rewritten, PHASE_1_2_ROUTING);
  }
  for (const changed of [
    step.replace("--prev-head <prior_head_sha>", "--prev-head <current_head_sha>"),
    step.replace("--head-sha <current_head_sha>", "") + "\n`other-command --head-sha <current_head_sha>`",
    step.replace("--spec-authority <identity-path>", "") + "\n`other-command --spec-authority <identity-path>`",
  ]) assert.throws(() => assertMatchesAll(changed, PHASE_1_2_ROUTING));
});

test("copilot-pr-followup Phase 2 routes to the owned fan-out procedure and pending emitter", async () => {
  const skill = await readRepo(SKILL);
  const line = extractStep(skill, "**Fan-out (Phase 2):**", SKILL);
  const links = extractRelativeMarkdownLinks(line).map(({ rawTarget }) => rawTarget);
  assert.ok(links.includes("../docs/gate-review-sub-loop-contract.md#phase-2--fan-out-independent-reviewers-seeded-with-the-neutral-bundle"));
  assertRuleOwned("GATE-EXEC-ANGLE-CARRY-FORWARD", SUB_LOOP_CONTRACT);
  assertRuleOwned("GATE-EXEC-FANOUT-DISPATCH-EMIT", SUB_LOOP_CONTRACT);
  assertMatchesAll(line, PHASE_2_ROUTING, `${SKILL} Phase 2 step`);
});

test("copilot-pr-followup SKILL's Phase 3 step attaches --provenance to the ledger write, not the comment post", async () => {
  const skill = await readRepo(SKILL);
  const line = extractStep(skill, "**Fan-in (Phase 3):**", SKILL);
  assertMatchesAll(line, PHASE_3_ROUTING, `${SKILL} Phase 3 step`);
  assert.doesNotMatch(
    line,
    PHASE_3_PROVENANCE_NOT_ON_COMMENT_POST,
    `${SKILL} Phase 3 step must not attach --provenance to the post-gate-findings.mjs comment post`,
  );
});

test("phase routing checks accept wrapped prose but cannot borrow a sibling's command", () => {
  const heading = "**Fan-in (Phase 3):**";
  const command = "`write-gate-findings-log.mjs --provenance '<json>'`";
  for (const prose of ["Record the carry.", "Preserve the prior\n   review identity."]) {
    const content = `5. ${heading} ${prose}\n\n   ${command} with \`carriedFromHead\`.\n6. **Verdict:** Next step.\n`;
    assertMatchesAll(extractStep(content, heading, "fixture"), PHASE_3_ROUTING);
  }
  for (const boundary of ["6. **Verdict:**", "## Next section"]) {
    const content = `5. ${heading} \`carriedFromHead\`.\n${boundary}\n${command}`;
    assert.throws(() => assertMatchesAll(extractStep(content, heading, "fixture"), PHASE_3_ROUTING));
  }
  assert.throws(() => extractStep(`6. **Verdict:** Mentions ${heading}`, heading, "fixture"));
  assert.throws(() => assert.doesNotMatch(
    "`post-gate-findings.mjs --provenance '<json>'`",
    PHASE_3_PROVENANCE_NOT_ON_COMMENT_POST,
  ));
});

test("the carry-forward CLI the SKILL routes to exists", async () => {
  await access(fromRepoRoot("scripts/github/resolve-angle-carry-forward.mjs"));
});

test("no gate-driving skill re-states a bare findings-only re-run rule, in any phrasing", async () => {
  // The old wording ("only re-run reviewers that produced findings") is a SECOND,
  // unevidenced scoping rule that silently overrides Phase 1.2 and would let a
  // previously-clean angle skip without proof its surface is untouched. It has to
  // be gone from EVERY skill that drives a gate retry, and from the mirrors —
  // leaving it in a sibling skill just moves the hole, and rewording it must not
  // resurrect it either.
  for (const file of GATE_DRIVING_SKILLS) {
    assert.doesNotMatch(
      await readRepo(file),
      BARE_FINDINGS_ONLY_RERUN_CLASS,
      `${file} must defer re-run scoping to the carry-forward step`,
    );
  }
});

test("copilot-pr-followup SKILL defers retry scoping to Phase 1.2 at both retry entry points", async () => {
  // The internal fan-out retry (Phase 5) and the pre-approval gate's retry rule
  // are the two places a bare "only re-run what had findings" rule could sneak
  // back in as an "obvious" restatement; both must point at Phase 1.2 instead.
  const skill = await readRepo(SKILL);
  const matches = skill.match(/Phase 1\.2 decides what re-runs/g) ?? [];
  assert.ok(matches.length >= 2, `${SKILL} must defer both retry entry points to Phase 1.2 (found ${matches.length})`);
});

test("local-implementation developer loop prescribes no gate angle retry scoping", async () => {
  // The developer implementation loop runs one self-check, not a gate angle
  // fan-out, so it no longer carries the fan-out retry rule. Angle carry-forward
  // (GATE-EXEC-ANGLE-CARRY-FORWARD) is a pull-request gate concern owned by the
  // gate-executing surfaces, per LOCAL-DEV-SELF-CHECK-NO-FANOUT.
  const file = "skills/local-implementation/SKILL.md";
  const skill = await readRepo(file);
  const loopMatch = skill.match(/## Implementation loop for the phase[\s\S]*?(?=\n## )/);
  assert.ok(loopMatch, `${file} must contain an 'Implementation loop for the phase' section`);
  assert.doesNotMatch(
    loopMatch[0],
    /GATE-EXEC-ANGLE-CARRY-FORWARD/,
    `${file} developer loop must not prescribe gate angle retry scoping`,
  );
});

test("the sub-loop contract's carry-forward rule states carry-forward as the default posture, not just a MAY", async () => {
  // Pins the AC4 posture flip so it cannot silently revert to the old MAY
  // wording: carry-forward must be stated as the default decision procedure,
  // with full re-dispatch named as the exception. Pinned on the source doc only;
  // claude-assets-reproducible.test.mjs proves the generated mirror matches it.
  {
    const file = SUB_LOOP_CONTRACT;
    const content = await readRepo(file);
    assert.match(
      content,
      /carried forward to the new head by default/,
      `${file} must state carry-forward as the default posture`,
    );
    assert.match(
      content,
      /A full\s*\nre-dispatch of the entire resolved angle set is the EXCEPTION/,
      `${file} must name full re-dispatch as the exception to the default`,
    );
  }
});

test("copilot-pr-followup SKILL's Phase 2 step injects the known-findings block after the angle prompt, never into the byte-identical prefix", async () => {
  // AC4's briefing half: the known-findings block is appended AFTER the
  // angle-specific prompt, not folded into GATE-EXEC-BRIEFING-PREFIX's
  // byte-identical prefix — folding it in would recompute the prefix hash on
  // every gate close and break the sanctioned same-head-retry sentinel. Pinned
  // on the source SKILL only; the generated mirror is covered by
  // claude-assets-reproducible.test.mjs byte-reproducibility.
  {
    const file = SKILL;
    const content = await readRepo(file);
    assertMatchesAll(
      content,
      [
        /known-findings block, appended AFTER this\s*\n\s*angle-specific prompt/,
        /never into the byte-identical prefix `GATE-EXEC-BRIEFING-PREFIX`/,
        /GATE-EXEC-FINDING-THREADS/,
      ],
      `${file} Phase 2 known-findings injection`,
    );
  }
});

test("detect-checkpoint-evidence.mjs has no gate-thread-specific second unresolved-thread counter", async () => {
  // Anti-double-enforcement pin: gate-authored finding threads must route
  // through the SAME unresolvedThreadCount check as every other review
  // thread, never a second, gate-scoped counter alongside it.
  const content = await readRepo("scripts/github/detect-checkpoint-evidence.mjs");
  assert.doesNotMatch(
    content,
    /gate[A-Za-z]*Thread[A-Za-z]*Count/,
    "detect-checkpoint-evidence.mjs must reconcile gate-authored threads through the single unresolvedThreadCount check, not a second gate-specific counter",
  );
});
