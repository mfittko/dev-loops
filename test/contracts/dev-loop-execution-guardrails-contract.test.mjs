import assert from "node:assert/strict";
import test from "node:test";

import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";
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
    /timeout 90 node --test <file>/,
    "the dev-loop SKILL should mandate a hard timeout on test runs",
  );
  assert.match(
    skill,
    /gh-mocking test that hangs on a real `gh`\/run-id call blocks the whole drive/i,
    "the bounded-test guardrail should name the failure mode",
  );
});

test("dev-loop SKILL enforces bounded Copilot/CI watch (#1660)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  assert.match(
    skill,
    /dev-loops gate probe-copilot --timeout-ms 300000/,
    "the bounded-watch guardrail should name the bounded probe invocation",
  );
  assert.match(
    skill,
    /never an unbounded 30min\+ blocking watch/i,
    "the bounded-watch guardrail should forbid unbounded blocking watches",
  );
  assert.match(
    skill,
    /#1537 hung 55min and #1525 hung 20min/i,
    "the bounded-watch guardrail should name the failure mode (the prior stalls)",
  );
});

test("loop-grill skill enforces the count-based AC unit + dispatch-mode guardrail (#1649)", async () => {
  const skill = await readRepo("skills/loop-grill/SKILL.md");
  assert.match(
    skill,
    /count-based acceptance criteria guardrail/i,
    "loop-grill should have a count-based AC guardrail section",
  );
  assertRulePresent("GRILL-COUNT-AC-UNIT-DISPATCH-MODE");
  assertRuleOwned("GRILL-COUNT-AC-UNIT-DISPATCH-MODE", "skills/loop-grill/SKILL.md");
  // The guardrail must require specifying the unit.
  assert.match(
    skill,
    /specify which unit the count refers to .* `sentinel` vs `angle` vs `dispatch-unit`/i,
    "the count-based AC guardrail must require specifying the unit",
  );
  // The guardrail must require validating against both dispatch modes.
  assert.match(
    skill,
    /validated against BOTH the per-angle default AND the shipped grouped-dispatch default/i,
    "the count-based AC guardrail must require validation against both dispatch modes",
  );
  // The cautionary case (#1618 AC3) must be referenced.
  assert.match(
    skill,
    /#1618 AC3/,
    "the count-based AC guardrail should reference the #1618 AC3 cautionary case",
  );
});
