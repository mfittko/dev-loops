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
// "re-run everything" rather than "re-run nothing".
// ---------------------------------------------------------------------------

const SKILL = "skills/copilot-pr-followup/SKILL.md";
const GENERATED_SKILL = ".claude/skills/copilot-pr-followup/SKILL.md";

// Every skill that drives a gate retry, source and generated mirror alike. The
// bare "only the angles that had findings" rule must survive in none of them.
const GATE_DRIVING_SKILLS = [
  SKILL,
  GENERATED_SKILL,
  "skills/local-implementation/SKILL.md",
  ".claude/skills/local-implementation/SKILL.md",
];

const CARRY_FORWARD_ROUTING = [
  // The CLI is named, with the prior head that makes the decision possible.
  /resolve-angle-carry-forward\.mjs/,
  /--prev-head/,
  // Only the angles it leaves to re-run get a fresh reviewer.
  /mustRerun/,
  // …but the dispatch set is the CURRENT head's resolved angles minus the carried
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
  // Provenance rides a separate flag; the ledger file does not carry it, so a
  // step that omits it drops every carried attribution.
  /--provenance/,
  // Round 1 has no prior head, so the step is explicitly skipped rather than
  // left to fail-closed refusal by accident.
  /Skip this step on a gate's first round/,
  // The rule itself stays owned by the contract doc.
  /GATE-EXEC-ANGLE-CARRY-FORWARD/,
  // A refusal must widen the fan-out, not silence it.
  /never treat exit 1 as "nothing to re-run"/,
];

test("copilot-pr-followup SKILL routes the gate fan-out through resolve-angle-carry-forward", async () => {
  const skill = await readRepo(SKILL);
  assertMatchesAll(skill, CARRY_FORWARD_ROUTING, SKILL);
});

test("the carry-forward CLI the SKILL routes to exists", async () => {
  await access(fromRepoRoot("scripts/github/resolve-angle-carry-forward.mjs"));
});

test("no gate-driving skill re-states a bare findings-only re-run rule", async () => {
  // The old wording ("only re-run reviewers that produced findings") is a SECOND,
  // unevidenced scoping rule that silently overrides Phase 1.2 and would let a
  // previously-clean angle skip without proof its surface is untouched. It has to
  // be gone from EVERY skill that drives a gate retry, and from the mirrors —
  // leaving it in a sibling skill just moves the hole.
  for (const file of GATE_DRIVING_SKILLS) {
    assert.doesNotMatch(
      await readRepo(file),
      /only re-run reviewers that produced/i,
      `${file} must defer re-run scoping to the carry-forward step`,
    );
  }
});

test("generated .claude mirror carries the same routing (when present)", async () => {
  let generated;
  try {
    generated = await readRepo(GENERATED_SKILL);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assertMatchesAll(generated, CARRY_FORWARD_ROUTING, GENERATED_SKILL);
});
