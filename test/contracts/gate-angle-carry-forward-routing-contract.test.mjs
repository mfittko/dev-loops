import { access } from "node:fs/promises";

import {
  assert,
  assertMatchesAll,
  flat,
  fromRepoRoot,
  hasClauseWith,
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
// These assertions pin the ROUTING, not the wording. What each step must carry
// is its executable surface (CLI name, flags, plan field names, owner rule ID)
// plus a structural property of the instruction (e.g. the dispatch set is
// defined by subtracting `carried`, and `mustRerun` is explicitly NOT the
// dispatch input). A meaning-preserving rewrite of the surrounding prose must
// keep passing; deleting the routing, the CLI, or the subtraction rule must
// fail. The discrimination tests at the bottom of this file exercise both
// directions against fixtures so the checkers cannot silently degrade into
// tautologies.
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

/**
 * Extract one numbered step of the fan-out/fan-in procedure by its bold
 * heading, from the heading line through the line before the next top-level
 * numbered step or the next `###` section.
 *
 * Structural, not layout-bound: the step may be one long line, a paragraph, or
 * a heading plus sub-bullets. A step that is deleted entirely (leaving only a
 * sibling step's mention of the same token) cannot satisfy a check, because the
 * heading anchor is gone.
 *
 * Exported for the discrimination tests below.
 */
export function extractStep(content, heading, file = "<fixture>") {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.includes(heading));
  assert.ok(start !== -1, `${file}: expected to find the ${JSON.stringify(heading)} step`);
  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((line) => /^\d+\.\s/.test(line) || /^#{1,3}\s/.test(line));
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return [lines[start], ...body].join("\n");
}

// `flat` (reflow-insensitive text) and `hasClauseWith` (one clause satisfies
// every pattern) are the shared prose-structure primitives from
// ../imported-assets-helpers.mjs.

// Phase 1.2 (Carry-forward): the step must invoke the seam's CLI with the
// identity inputs it needs, name the plan fields it returns, defer the rule
// itself to its owner, and state the two fail-safe branches (full SHAs, and a
// refusal widening the fan-out rather than silencing it).
export function assertPhase12Routing(step, label) {
  const text = flat(step);
  // Executable surface: exact by design (CLI + flags + returned plan fields).
  assertMatchesAll(text, [
    /resolve-angle-carry-forward\.mjs/,
    /--prev-head/,
    /--head-sha/,
    /\bcarried\b/,
    /mustRerun/,
    /carriedFromHead/,
    /GATE-EXEC-ANGLE-CARRY-FORWARD/,
  ], label);
  // Structural: the SHA form is stated as full-length, in any phrasing.
  assert.match(text, /40[- ]?(?:character|char|hex|digit)/i,
    `${label}: must require the FULL 40-character SHA form for --prev-head/--head-sha`);
  // Structural: the dispatch set is defined by SUBTRACTING carried angles.
  assert.ok(
    hasClauseWith(step, /\b(?:minus|subtract\w*|remov\w+|excluding|excluded)\b/i, /\bcarried\b/i),
    `${label}: dispatch must be defined as the resolved angle set MINUS the carried angles`,
  );
  // Structural: mustRerun is explicitly not the dispatch input.
  assert.ok(
    hasClauseWith(step, /mustRerun/, /\b(?:never|not|informational|advisory)\b/i),
    `${label}: mustRerun must be marked non-authoritative for dispatch`,
  );
  // Structural: a CLI refusal widens the fan-out (fail-safe direction).
  assert.ok(
    hasClauseWith(step, /\b(?:non-zero|exit 1|refus\w+)\b/i, /\b(?:every|all|full)\b/i, /\bangles?\b/i),
    `${label}: a carry-forward refusal must fan out every resolved angle, never zero`,
  );
  // Structural: round 1 has no prior head and is skipped explicitly.
  assert.match(text, /\bfirst round\b|\bno prior head\b/i,
    `${label}: must say the step is skipped on a gate's first round (no prior head)`);
}

// Phase 2 (Fan-out): the emitter is the sanctioned dispatch step, and the
// dispatch set is still the subtraction Phase 1.2 produced.
export function assertPhase2Dispatch(step, label) {
  const text = flat(step);
  assertMatchesAll(text, [
    /emit-fanout-dispatch\.mjs/,
    /--pending/,
    /promptPath/,
    /maxConcurrent/,
    /GATE-EXEC-FANOUT-DISPATCH-EMIT/,
  ], label);
  // Structural: the wave bound is the emitter's own field, never the wave plan.
  assert.ok(
    hasClauseWith(step, /wavePlan/, /\b(?:not|never)\b/i),
    `${label}: must forbid bounding the fan-out by artifact.fanout.wavePlan`,
  );
  // Structural: the carried subset drives whether --pending is passed.
  assert.match(text, /carried/i, `${label}: must branch on the Phase 1.2 carried subset`);
}

// Phase 3 (Fan-in): --provenance belongs to the LEDGER WRITE, not the comment
// post. Anchored inside one backtick-delimited code span so a reattached flag
// on the comment-post command is caught.
const PROVENANCE_ON_LEDGER_WRITE = /write-gate-findings-log\.mjs[^`]*--provenance/;
const PROVENANCE_ON_COMMENT_POST = /post-gate-findings\.mjs[^`]*--provenance/;

export function assertPhase3Provenance(step, label) {
  assertMatchesAll(step, [PROVENANCE_ON_LEDGER_WRITE, /carriedFromHead/], label);
  assert.doesNotMatch(
    step,
    PROVENANCE_ON_COMMENT_POST,
    `${label}: --provenance must not be attached to the post-gate-findings.mjs comment post`,
  );
}

// The class of banned rule this PR removed: "re-run only ... (findings |
// findings_present) ... previous pass/head/round". Broad enough to catch a
// reworded reintroduction of the SAME scoping rule, not just the one literal
// phrasing this PR happened to delete.
const BARE_FINDINGS_ONLY_RERUN_CLASS =
  /\bonly\b[^.\n]{0,80}\b(?:findings_present|findings)\b[^.\n]{0,60}\bprevious\s+(?:pass|head|round)\b/i;

test("copilot-pr-followup SKILL's Phase 1.2 step routes the fan-out through resolve-angle-carry-forward", async () => {
  const skill = await readRepo(SKILL);
  const step = extractStep(skill, "**Carry-forward (Phase 1.2):**", SKILL);
  assertPhase12Routing(step, `${SKILL} Phase 1.2 step`);
});

test("copilot-pr-followup SKILL's Phase 2 step dispatches only the angles Phase 1.2 left to re-run", async () => {
  const skill = await readRepo(SKILL);
  const step = extractStep(skill, "**Fan-out (Phase 2):**", SKILL);
  assertPhase2Dispatch(step, `${SKILL} Phase 2 step`);
});

test("copilot-pr-followup SKILL's Phase 3 step attaches --provenance to the ledger write, not the comment post", async () => {
  const skill = await readRepo(SKILL);
  const step = extractStep(skill, "**Fan-in (Phase 3):**", SKILL);
  assertPhase3Provenance(step, `${SKILL} Phase 3 step`);
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
  // with full re-dispatch named as the exception. Whitespace-insensitive so a
  // reflowed paragraph does not false-fail. Pinned on the source doc only;
  // claude-assets-reproducible.test.mjs proves the generated mirror matches it.
  const file = SUB_LOOP_CONTRACT;
  const content = flat(await readRepo(file));
  assert.match(
    content,
    /carried forward to the new head by default/,
    `${file} must state carry-forward as the default posture`,
  );
  assert.match(
    content,
    /A full re-dispatch of the entire resolved angle set is the EXCEPTION/,
    `${file} must name full re-dispatch as the exception to the default`,
  );
});

test("copilot-pr-followup SKILL's Phase 2 step injects the known-findings block after the angle prompt, never into the byte-identical prefix", async () => {
  // AC4's briefing half: the known-findings block is appended AFTER the
  // angle-specific prompt, not folded into GATE-EXEC-BRIEFING-PREFIX's
  // byte-identical prefix — folding it in would recompute the prefix hash on
  // every gate close and break the sanctioned same-head-retry sentinel.
  // Whitespace-insensitive: the obligation is the ordering, not the line breaks.
  const content = flat(await readRepo(SKILL));
  assertMatchesAll(
    content,
    [
      /known-findings block, appended AFTER this angle-specific prompt/,
      /never into the byte-identical prefix `GATE-EXEC-BRIEFING-PREFIX`/,
      /GATE-EXEC-FINDING-THREADS/,
    ],
    `${SKILL} Phase 2 known-findings injection`,
  );
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

// ---------------------------------------------------------------------------
// Discrimination tests: prove the checkers above accept meaning-preserving
// rewording and reject a structural violation. Without these, a checker that
// decayed into a tautology (or into a wording pin) would look identical from
// the outside.
// ---------------------------------------------------------------------------

// Same obligations as the shipped Phase 1.2 step, different words, different
// line layout (sub-bullets instead of one long line) and different ordering.
const PHASE_1_2_REWORDED = `2. **Carry-forward (Phase 1.2):** skip on a gate's first round, since there is no prior head.
   - Invoke \`node scripts/github/resolve-angle-carry-forward.mjs --repo <r> --pr <n> --gate <g> --prev-head <A> --head-sha <B>\`.
   - Give both SHAs in their full 40-character spelling; a shortened one resolves no log.
   - The emitted plan carries \`carried\` and \`mustRerun\`. Build the dispatch set by removing the
     \`carried\` angles from this head's resolved set. \`mustRerun\` is advisory and MUST NOT drive dispatch.
   - Any non-zero exit means fan out all resolved angles, exactly as on a round with no prior head.
   - Carried entries keep \`carriedFromHead\` and the prior reviewer identity; \`GATE-EXEC-ANGLE-CARRY-FORWARD\` owns the rule.
3. **Next step**`;

// Violations: each drops ONE structural obligation while keeping every token a
// keyword-presence check would see.
const PHASE_1_2_NO_SUBTRACTION = PHASE_1_2_REWORDED.replace(
  /Build the dispatch set by removing the\s*\n\s*`carried` angles from this head's resolved set\. `mustRerun` is advisory and MUST NOT drive dispatch\./,
  "Dispatch the angles the plan lists, using `carried` and `mustRerun` as the reviewer sees fit.",
);
const PHASE_1_2_REFUSAL_SILENCES = PHASE_1_2_REWORDED.replace(
  "Any non-zero exit means fan out all resolved angles, exactly as on a round with no prior head.",
  "Any non-zero exit means there is nothing to re-run; continue to the next phase.",
);

test("Phase 1.2 checker accepts a meaning-preserving rewrite of the same obligations", () => {
  const step = extractStep(PHASE_1_2_REWORDED, "**Carry-forward (Phase 1.2):**");
  assertPhase12Routing(step, "reworded fixture");
});

test("Phase 1.2 checker rejects a step that drops the subtract-not-substitute rule", () => {
  const step = extractStep(PHASE_1_2_NO_SUBTRACTION, "**Carry-forward (Phase 1.2):**");
  assert.throws(() => assertPhase12Routing(step, "violating fixture"));
});

test("Phase 1.2 checker rejects a step that turns a CLI refusal into 'nothing to re-run'", () => {
  const step = extractStep(PHASE_1_2_REFUSAL_SILENCES, "**Carry-forward (Phase 1.2):**");
  assert.throws(() => assertPhase12Routing(step, "violating fixture"));
});

test("extractStep bounds a step at the next numbered step, so a deleted step cannot borrow its sibling's text", () => {
  const doc = `1. **Fan-in (Phase 3):** write the ledger with \`write-gate-findings-log.mjs --provenance '<json>'\` recording \`carriedFromHead\`.
2. **Verdict (Phase 4):** post the verdict.`;
  const phase3 = extractStep(doc, "**Fan-in (Phase 3):**");
  assertPhase3Provenance(phase3, "fixture Phase 3");
  const phase4 = extractStep(doc, "**Verdict (Phase 4):**");
  assert.doesNotMatch(phase4, PROVENANCE_ON_LEDGER_WRITE, "step extraction must not leak the previous step's text");
});

test("Phase 3 checker rejects --provenance reattached to the comment post", () => {
  const violating = `1. **Fan-in (Phase 3):** record \`carriedFromHead\` and post via \`post-gate-findings.mjs --findings-file <p> --provenance '<json>'\` plus \`write-gate-findings-log.mjs --findings-file <p> --provenance '<json>'\`.
2. **Verdict (Phase 4):** post the verdict.`;
  const step = extractStep(violating, "**Fan-in (Phase 3):**");
  assert.throws(() => assertPhase3Provenance(step, "violating fixture"));
});
