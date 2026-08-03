import { access } from "node:fs/promises";

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
const GENERATED_SKILL = ".claude/skills/copilot-pr-followup/SKILL.md";
const SUB_LOOP_CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";
const GENERATED_SUB_LOOP_CONTRACT = ".claude/skills/docs/gate-review-sub-loop-contract.md";

// Every skill that drives a gate retry, source and generated mirror alike. The
// bare "only the angles that had findings" rule must survive in none of them.
// The sub-loop contract owns GATE-EXEC-ANGLE-CARRY-FORWARD itself, and every
// AC4 sentence lands there, so it is in scope for this guard too.
const GATE_DRIVING_SKILLS = [
  SKILL,
  GENERATED_SKILL,
  "skills/local-implementation/SKILL.md",
  ".claude/skills/local-implementation/SKILL.md",
  SUB_LOOP_CONTRACT,
  GENERATED_SUB_LOOP_CONTRACT,
];

// Each numbered procedure step in the fan-out/fan-in section is one long line
// starting "N. **<heading>:**" (see the section this pins). Extract by heading
// substring so a mutation that deletes the whole step (leaving only the header
// or a sibling step's mention of the same token) cannot satisfy the check.
function extractStepLine(content, heading, file) {
  const line = content.split("\n").find((l) => l.includes(heading));
  assert.ok(line, `${file}: expected to find the ${JSON.stringify(heading)} step`);
  return line;
}

// Phase 1.2 (Carry-forward): names the CLI, the SHA form it requires, the
// subtract-not-substitute dispatch rule, and treats a refusal as full fan-out.
const PHASE_1_2_ROUTING = [
  /resolve-angle-carry-forward\.mjs/,
  /--prev-head/,
  /mustRerun/,
  // …the dispatch set is the CURRENT head's resolved angles minus the carried
  // ones, never the plan's own lists — the plan's universe is the PRIOR head's
  // angle set, so an angle first resolved at this head appears in neither list
  // and would otherwise go unreviewed.
  /subtract, never substitute/,
  /minus the plan's `carried` angles/,
  // An abbreviated prev-head resolves no log file, so carry-forward would refuse
  // forever without ever saying why.
  /FULL 40-character form/,
  // Carried angles keep the prior reviewer's identity and head, never a fake one.
  /carriedFromHead/,
  /never a fabricated fresh review/i,
  // Round 1 has no prior head, so the step is explicitly skipped rather than
  // left to fail-closed refusal by accident.
  /Skip this step on a gate's first round/,
  // The rule itself stays owned by the contract doc.
  /GATE-EXEC-ANGLE-CARRY-FORWARD/,
  // A refusal must widen the fan-out, not silence it.
  /never treat exit 1 as "nothing to re-run"/,
];

// Phase 2 (Fan-out): must dispatch by SUBTRACTION — the current head's
// resolved angle set minus the plan's carried angles, never the plan's
// mustRerun field — this is the clause that makes the carry-forward plan
// operative rather than advisory, pinned in its unambiguous form.
const PHASE_2_ROUTING = [
  /resolved angle set minus the plan's `carried` angles \(the Phase 1\.2 subtraction — never `mustRerun`\)/,
];

// Phase 3 (Fan-in): --provenance belongs to the LEDGER WRITE, not the comment
// post — pinned on this line specifically so a reworded sentence that reattaches
// the flag to the wrong command (the exact defect this pins) fails here. The
// whole step is ONE line, so `[^\n]*` spans it end to end and cannot fail on a
// reattached flag; anchor inside the backtick-delimited code span instead
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
  const line = extractStepLine(skill, "**Carry-forward (Phase 1.2):**", SKILL);
  assertMatchesAll(line, PHASE_1_2_ROUTING, `${SKILL} Phase 1.2 step`);
});

test("copilot-pr-followup SKILL's Phase 2 step dispatches only the angles Phase 1.2 left to re-run", async () => {
  const skill = await readRepo(SKILL);
  const line = extractStepLine(skill, "**Fan-out (Phase 2):**", SKILL);
  assertMatchesAll(line, PHASE_2_ROUTING, `${SKILL} Phase 2 step`);
});

test("copilot-pr-followup SKILL's Phase 3 step attaches --provenance to the ledger write, not the comment post", async () => {
  const skill = await readRepo(SKILL);
  const line = extractStepLine(skill, "**Fan-in (Phase 3):**", SKILL);
  assertMatchesAll(line, PHASE_3_ROUTING, `${SKILL} Phase 3 step`);
  assert.doesNotMatch(
    line,
    PHASE_3_PROVENANCE_NOT_ON_COMMENT_POST,
    `${SKILL} Phase 3 step must not attach --provenance to the post-gate-findings.mjs comment post`,
  );
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

test("local-implementation SKILL defers retry scoping to GATE-EXEC-ANGLE-CARRY-FORWARD", async () => {
  const file = "skills/local-implementation/SKILL.md";
  const skill = await readRepo(file);
  assert.match(
    skill,
    /GATE-EXEC-ANGLE-CARRY-FORWARD[^.\n]*decides what re-runs/,
    `${file} must defer retry scoping to GATE-EXEC-ANGLE-CARRY-FORWARD`,
  );
});

test("generated .claude mirrors carry the same routing (when present)", async () => {
  for (const [file, heading, patterns] of [
    [GENERATED_SKILL, "**Carry-forward (Phase 1.2):**", PHASE_1_2_ROUTING],
    [GENERATED_SKILL, "**Fan-out (Phase 2):**", PHASE_2_ROUTING],
    [GENERATED_SKILL, "**Fan-in (Phase 3):**", PHASE_3_ROUTING],
  ]) {
    let generated;
    try {
      generated = await readRepo(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const line = extractStepLine(generated, heading, file);
    assertMatchesAll(line, patterns, `${file} ${heading}`);
    if (patterns === PHASE_3_ROUTING) {
      assert.doesNotMatch(
        line,
        PHASE_3_PROVENANCE_NOT_ON_COMMENT_POST,
        `${file} Phase 3 step must not attach --provenance to the post-gate-findings.mjs comment post`,
      );
    }
  }
});

test("the sub-loop contract's carry-forward rule states carry-forward as the default posture, not just a MAY", async () => {
  // Pins the AC4 posture flip so it cannot silently revert to the old MAY
  // wording: carry-forward must be stated as the default decision procedure,
  // with full re-dispatch named as the exception, in both the source doc and
  // its generated mirror.
  for (const file of [SUB_LOOP_CONTRACT, GENERATED_SUB_LOOP_CONTRACT]) {
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
  // every gate close and break the sanctioned same-head-retry sentinel.
  for (const file of [SKILL, GENERATED_SKILL]) {
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
