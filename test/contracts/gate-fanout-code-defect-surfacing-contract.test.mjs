import {
  assert,
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";

// ---------------------------------------------------------------------------
// AC#5 (#885) regression/contract guard.
//
// AC#5 of issue #885 asks for a regression/contract test demonstrating that the
// gate-review fan-out now surfaces code-level defects (the enabling mechanism is
// a PROMPT-level change to the scoped reviewer briefing). The substantive code
// fix lives in the agent/skill prompts, not in a single JS function, so this
// test pins the three enabling directives in place so a future edit that
// silently drops them fails CI:
//   (a) read the FULL diff via scope.diffPath (not just hunks),
//   (b) review ADVERSARIALLY for concrete code-level defects (NaN / Infinity /
//       coercion / boundary / "adversarial"),
//   (c) the contextWidened scope-widening affordance for read-only reviewers.
//
// We assert against both the source agent (agents/review.agent.md) and the skill
// that drives the fan-out (skills/copilot-pr-followup/SKILL.md), and — when the
// generated mirror exists — the generated .claude/agents/review.md too, so the
// generated asset cannot drift from the source.
// ---------------------------------------------------------------------------

const FULL_DIFF_DIRECTIVE = [
  /scope\.diffPath/,
  /FULL diff/i,
];

const ADVERSARIAL_DIRECTIVE = [
  /adversarial/i,
  /NaN/,
  /Infinity/,
  /coercion/i,
  /boundary/i,
];

const CONTEXT_WIDENED_AFFORDANCE = [
  /contextWidened/,
];

test("AC#5: review agent scoped-mode carries the full-diff + adversarial + contextWidened directives", async () => {
  const reviewAgent = await readRepo("agents/review.agent.md");
  assertMatchesAll(reviewAgent, FULL_DIFF_DIRECTIVE, "agents/review.agent.md");
  assertMatchesAll(reviewAgent, ADVERSARIAL_DIRECTIVE, "agents/review.agent.md");
  assertMatchesAll(reviewAgent, CONTEXT_WIDENED_AFFORDANCE, "agents/review.agent.md");
});

test("AC#5: copilot-pr-followup SKILL briefs scoped reviewers to read the full diff and review adversarially, recording contextWidened", async () => {
  const skill = await readRepo("skills/copilot-pr-followup/SKILL.md");
  assertMatchesAll(skill, FULL_DIFF_DIRECTIVE, "skills/copilot-pr-followup/SKILL.md");
  assertMatchesAll(skill, ADVERSARIAL_DIRECTIVE, "skills/copilot-pr-followup/SKILL.md");
  assertMatchesAll(skill, CONTEXT_WIDENED_AFFORDANCE, "skills/copilot-pr-followup/SKILL.md");
});

test("AC#5: generated .claude/agents/review.md mirrors the source enabling directives (when present)", async () => {
  let generated;
  try {
    generated = await readRepo(".claude/agents/review.md");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Generated mirror is optional in this tree; the source agent test above
      // is the load-bearing guard. Skip rather than fail when it is absent.
      return;
    }
    throw err;
  }
  assertMatchesAll(generated, FULL_DIFF_DIRECTIVE, ".claude/agents/review.md");
  assertMatchesAll(generated, ADVERSARIAL_DIRECTIVE, ".claude/agents/review.md");
  assertMatchesAll(generated, CONTEXT_WIDENED_AFFORDANCE, ".claude/agents/review.md");
});

test("AC#5: full-diff directive ties the reviewer to scope.diffPath with a git diff fallback (no hunk-only review)", async () => {
  const [reviewAgent, skill] = await Promise.all([
    readRepo("agents/review.agent.md"),
    readRepo("skills/copilot-pr-followup/SKILL.md"),
  ]);
  // The reviewer must be told to reconstruct the diff when scope.diffPath is
  // null/missing, so a captured-diff write failure cannot silently degrade the
  // fan-out into a hunk-only review.
  assert.match(reviewAgent, /git diff/i, "agents/review.agent.md should give a git diff fallback when scope.diffPath is null");
  assert.match(skill, /git diff/i, "skills/copilot-pr-followup/SKILL.md should give a git diff fallback when scope.diffPath is null");
});
