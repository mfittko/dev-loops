import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

// ADR 0208 (#2462 slice 8): GATE-EXEC-ROUND-CAP states the cap round fixed goes ready; the closure round (count cap+1) is gone from the rule.
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("GATE-EXEC-ROUND-CAP states the cap-round fix, the ready transition and the round N+1 refusal", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP -->")[1].split("\n")[1];
  for (const text of ["`judgeFix`", "composes `findings_present`", "Rounds 1 to N run, including the cap round N", "Round N+1 never runs", "refuses a `draft_gate` post whose count is above the cap with `round_cap_reached`", "`mark_ready_for_review` and never `run_draft_gate`", "`resolveCapRoundFixed`", "`ready-for-review.mjs` accepts this \"cap round fixed\" state in place of a clean current-head verdict", "CI, size, ADR tripwire and spec conditions stay fail-closed", "post-cap `blocked` draft verdict", "no marker, cap raise or supersede", "`scope.capRoundResidue`", "ADR 0208", "the cap-round remedy clause", "When the deferral target of a `medium` resolves to the PR itself, the defer is not final, the round composes `blocked` with `severity_disagreement`, and the coordinator escalates", "A `low` deferred to the PR itself stays cap-closed under `GATE-EXEC-LOW-FIX-UNTIL-CAP`"]) {
    assert.ok(rule.includes(text), text);
  }
  assert.doesNotMatch(rule, /\b(should|may|usually)\b/i);
  for (const gone of ["a closure round (count cap+1)", "`scope.closureRound`", "`closureRound: true`", "closure round: diff from"]) assert.ok(!rule.includes(gone), gone);
});

test("GATE-EXEC-FIXER-CYCLE-BOUND names the draft_gate round cap and no closure round", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const line = contract.split("\n").find((l) => l.startsWith("`GATE-EXEC-FIXER-CYCLE-BOUND`"));
  assert.ok(line.includes("`GATE-EXEC-ROUND-CAP`"));
  assert.ok(!/closure/i.test(line));
});

test("the judge brief carries the closure-round rule and cites the owning rule", async () => {
  const judge = await read("agents/judge.agent.md");
  assert.match(judge, /closure round \(work order `closureRound: true`, `GATE-EXEC-ROUND-CAP`\)/);
});
