import assert from "node:assert/strict";
import { test } from "bun:test";

import { assertRuleOwned, assertRulePresent, extractOwnedText } from "./_rule-helpers.mjs";
import { readRepo } from "../imported-assets-helpers.mjs";

// Guardrails added by the rc.5 agent-instruction-guardrails docs bundle
// (#1637, #1650, #1660, #1649). These contract checks pin the presence of the
// guidance at its canonical surface so a doc reword cannot silently drop it.

test("dev-loop SKILL inlines the sanctioned consolidate-fanin fan-out dispatch imperative (#1637)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  // The gate fan-out dispatch guardrail names the CLI inline (not only via cross-ref).
  assert.match(
    skill,
    /dev-loops gate consolidate-fanin --findings-dir <dir> --head-sha <current_head_sha> --gate <gate>/,
    "the dev-loop SKILL should inline the consolidate-fanin invocation at the dispatch guardrail",
  );
  // The never-hand-roll rule is visible at the dispatch guardrail.
  assert.match(
    skill,
    /Never hand-roll reviewer dispatch via `Promise\.all\(runs\.run\)` \+ transcript-tailing/i,
    "the dev-loop SKILL should state the never-hand-roll rule at the dispatch guardrail",
  );
  assert.match(
    skill,
    /await each reviewer's findings artifact at its deterministic output path/i,
    "the dev-loop SKILL should require awaiting the findings artifact at its deterministic path",
  );
});

test("dev-loop SKILL enforces bounded-timeout test runs (#1650)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  assert.match(
    skill,
    /timeout 90 bun test <file>/,
    "the dev-loop SKILL should mandate a hard timeout on test runs",
  );

});

test("dev-loop SKILL enforces bounded Copilot/CI watch (#1660)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  assert.match(
    skill,
    /dev-loops gate probe-copilot --timeout-ms 300000/,
    "the bounded-watch guardrail should name the bounded probe invocation",
  );
  assert.match(skill, /timeout 600 <cmd>/);
  // Prior-stall anecdotes and wording cannot prove the timeout policy.
  // probe-copilot-review/run-watch-cycle tests cover executable timeout behavior.

});

test("dev-loop contract pins a bounded FOREGROUND inline probe for the Copilot/CI wait and forbids the backgrounded sleep-poll (#2065)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  const agent = await readRepo("agents/dev-loop.agent.md");
  for (const [name, doc] of [["SKILL", skill], ["agent", agent]]) {
    // the sanctioned wait names the bounded foreground inline probe scripts
    assert.match(doc, /probe-copilot-review\.mjs/, `${name} should name the bounded foreground probe script`);
    assert.match(doc, /wait-pr-checks\.mjs/, `${name} should name the CI wait probe script`);
    // Assert the sentence SEMANTICS, not just isolated words (Copilot review, #2065): each doc must
    // (a) tie a FOREGROUND probe to an explicit --timeout/--timeout-ms bound, and (b) explicitly
    // FORBID/ban the backgrounded wait — a doc that merely mentioned "background" while permitting
    // it must fail. The two assertions below each require a foreground+bounded phrase and a
    // prohibition phrase in proximity to the wait subject.
    assert.match(
      doc,
      /foreground[\s\S]{0,160}--timeout(?:-ms)?|--timeout(?:-ms)?[\s\S]{0,160}foreground/i,
      `${name} should tie the FOREGROUND probe to an explicit --timeout/--timeout-ms bound`,
    );
    assert.match(
      doc,
      /(?:forbidden|never|must not|banned|barred)[\s\S]{0,80}background|background[\s\S]{0,120}(?:forbidden|never|must not|banned|barred|orphan)/i,
      `${name} should explicitly forbid the backgrounded wait, not merely mention "background"`,
    );
    // the backgrounded sleep-poll / bare-& form is named as the prohibited shape
    assert.match(doc, /sleep|&/i, `${name} should name the sleep-poll / bare-& form`);
  }
});

test("loop-grill skill enforces the count-based AC unit + dispatch-mode guardrail (#1649)", async () => {
  const skill = await readRepo("skills/loop-grill/SKILL.md");
  assertRulePresent("GRILL-COUNT-AC-UNIT-DISPATCH-MODE");
  assertRuleOwned("GRILL-COUNT-AC-UNIT-DISPATCH-MODE", "skills/loop-grill/SKILL.md");
  const owned = extractOwnedText(skill, "GRILL-COUNT-AC-UNIT-DISPATCH-MODE");
  for (const unit of ["sentinel", "angle", "dispatch-unit"]) {
    assert.ok(owned.includes("`" + unit + "`"), `missing count unit: ${unit}`);
  }
  // Owner/token checks do not prove both-mode validation: that agent duty is
  // reviewed semantically; historical incident numbers are not its contract.

});
