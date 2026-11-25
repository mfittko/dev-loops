import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

// ADR 0208 (#2462 slice 8): GATE-EXEC-ROUND-CAP states the cap round fixed goes ready; the closure round (count cap+1) is gone from the rule.
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("GATE-EXEC-ROUND-CAP states the cap-round fix and defers the round after the cap to GATE-EXEC-CAP-BRAKES", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP -->")[1].split("\n")[1];
  for (const text of ["composes `findings_present`", "Rounds 1 to N run, including the cap round N", "The round after the cap round is decided by `GATE-EXEC-CAP-BRAKES` (ADR 0324)", "A draft PR goes ready only on clean current-head `draft_gate` evidence (ADR 0324)", "`resolveCapRoundFixed`", "CI, size, ADR tripwire and spec conditions stay fail-closed", "post-cap `blocked` draft verdict", "no marker, cap raise or supersede", "`scope.capRoundResidue`", "ADR 0208", "`GATE-EXEC-SOFT-CAP` states the cap-round blocker set (ADR 0251)", "an act list holding a `low` and a mixed list follow `GATE-EXEC-SOFT-CAP`, and an all-`nit` list follows `GATE-EXEC-LOW-FIX-UNTIL-CAP`", "A judge's own `low` defer or reject at the draft cap round is cap-closed under this rule"]) {
    assert.ok(rule.includes(text), text);
  }
  assert.doesNotMatch(rule, /\b(should|may|usually)\b/i);
  assert.ok(!rule.includes("remedy clause"), "no dangling remedy clause reference");
  for (const gone of ["a closure round (count cap+1)", "`scope.closureRound`", "`closureRound: true`", "closure round: diff from"]) assert.ok(!rule.includes(gone), gone);
});

test("GATE-EXEC-FIXER-CYCLE-BOUND names the draft_gate round cap and no closure round", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const line = contract.split("\n").find((l) => l.startsWith("`GATE-EXEC-FIXER-CYCLE-BOUND`"));
  assert.ok(line.includes("`GATE-EXEC-ROUND-CAP`"));
  assert.ok(!/closure/i.test(line));
});

test("the judge brief names the draft closure round as superseded by ADR 0208 and the pre_approval_gate scoped final round", async () => {
  const judge = await read("agents/judge.agent.md");
  assert.match(judge, /`draft_gate` closure round stays superseded by ADR 0208 \(`GATE-EXEC-ROUND-CAP`\)/);
  assert.match(judge, /scoped final round \(work order `closureRound: true`, `GATE-EXEC-CAP-BRAKES`\)/);
  assert.doesNotMatch(judge, /In a closure round/);
});

// ADR 0324: the cap exit rule is gone; the draft exit is the clean scoped final round of GATE-EXEC-CAP-BRAKES.
test("the draft cap exit rule is deleted and GATE-EXEC-CAP-BRAKES names the draft default 2 and the scoped draft exit; the low-nit sentence names the scoped round", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(!contract.includes(["GATE-EXEC-ROUND-CAP", "EXIT"].join("-")), "the cap exit rule and every reference are gone");
  const brakes = contract.split("<!-- rule: GATE-EXEC-CAP-BRAKES -->")[1].split("\n")[1];
  for (const text of ["(default 2, `0` disables the cap)", "(3) Growth:"]) assert.ok(brakes.includes(text), text);
  // AC4: the rule carries no ADR 0324 sentence; GATE-EXEC-ROUND-CAP states the draft exit and the enforcementNote carries the growth-read detail.
  assert.ok(!brakes.includes("ADR 0324"), "GATE-EXEC-CAP-BRAKES carries no ADR 0324 sentence");
  assert.ok(contract.includes("A draft PR goes ready only on clean current-head `draft_gate` evidence (ADR 0324)."), "GATE-EXEC-ROUND-CAP states the draft exit");
  assert.ok((await read("skills/docs/required-rules.json")).includes("forecastWlocs in spec-lint.mjs"), "the growth-read detail lives in the enforcementNote");
  assert.ok(!brakes.includes("slice 2"), "no slice sentence is left");
  for (const doc of [contract, await read("skills/copilot-pr-followup/SKILL.md")]) assert.match(doc, /any refusal keeps the full round, except at the cap: a `locally_clear` delta result that carries a new low finding ends in the scoped final round after the push \(`GATE-EXEC-CAP-BRAKES`\)/i);
  assert.ok(!contract.includes("Any refusal keeps the full round."), "the unqualified sentence is gone");
  assert.ok(!(await read("skills/copilot-pr-followup/SKILL.md")).includes("Below the cap a refusal keeps the full round"), "the duplicated sentence is gone");
  const adr = await read("docs/decisions/0324-draft-cap-two-and-scoped-draft-exit.md");
  assert.ok(adr.includes("Amends ADR 0322, ADR 0320 and ADR 0208"));
});
