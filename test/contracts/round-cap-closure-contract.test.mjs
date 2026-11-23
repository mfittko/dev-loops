import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

// ADR 0208 (#2462 slice 8): GATE-EXEC-ROUND-CAP states the cap round fixed goes ready; the closure round (count cap+1) is gone from the rule.
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("GATE-EXEC-ROUND-CAP states the cap-round fix, the ready transition and the round N+1 refusal", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP -->")[1].split("\n")[1];
  for (const text of ["composes `findings_present`", "Rounds 1 to N run, including the cap round N", "Round N+1 never runs", "refuses a `draft_gate` post whose count is above the cap with `round_cap_reached`", "`mark_ready_for_review` and never a further draft round", "`resolveCapRoundFixed`", "`ready-for-review.mjs` accepts this \"cap round fixed\" state in place of a clean current-head verdict", "CI, size, ADR tripwire and spec conditions stay fail-closed", "post-cap `blocked` draft verdict", "no marker, cap raise or supersede", "`scope.capRoundResidue`", "ADR 0208", "`GATE-EXEC-SOFT-CAP` states the cap-round blocker set (ADR 0251)", "an act list holding a `low` and a mixed list follow `GATE-EXEC-SOFT-CAP`, and an all-`nit` list follows `GATE-EXEC-LOW-FIX-UNTIL-CAP`", "A judge's own `low` defer or reject at the draft cap round is cap-closed under this rule"]) {
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

test("the judge brief names the closure round as superseded by ADR 0208", async () => {
  const judge = await read("agents/judge.agent.md");
  assert.match(judge, /closure round \(work order `closureRound: true`, count cap\+1\) is superseded by ADR 0208 \(`GATE-EXEC-ROUND-CAP`\)/);
  assert.doesNotMatch(judge, /In a closure round/);
});

// Issue 3460 AC8, AC9, AC11: the cap exit rule, the escalation third outcome and the low-nit cap sentence.
test("GATE-EXEC-ROUND-CAP-EXIT states the exit, the blocked rule, the seeding and the escalated-item binding; the low-nit sentence names the exit at the cap", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP-EXIT -->")[1].split("\n")[1];
  for (const text of ["`capExitHolds`", "a trusted posted `draft_gate` review exists at the cap-round head", "reads no delta record", "A blocked round never takes the exit", "`pastCapBlockers`", "seeds each open act item of the cap round as a finding", "`cap:<fingerprint>`", "names by fingerprint, with a `decision`", "choose a third outcome", "ADR 0320"]) assert.ok(rule.includes(text), text);
  assert.ok(contract.includes("for one of three outcomes") && contract.includes("The third outcome, at the cap round"), "the escalation rule names the fix in this PR");
  for (const doc of [contract, await read("skills/copilot-pr-followup/SKILL.md")]) assert.match(doc, /any refusal keeps the full round, except at the cap: a `locally_clear` delta result that carries a new low finding ends in ready through the cap exit \(`GATE-EXEC-ROUND-CAP-EXIT`\)/i);
  assert.ok(!contract.includes("Any refusal keeps the full round."), "the unqualified sentence is gone");
  assert.ok(!(await read("skills/copilot-pr-followup/SKILL.md")).includes("Below the cap a refusal keeps the full round"), "the duplicated sentence is gone");
  assert.ok((await read("docs/decisions/0320-cap-exit-from-the-posted-cap-review.md")).includes("Amends ADR 0208, ADR 0218, ADR 0250 and ADR 0317"));
});
