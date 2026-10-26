import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

// ADR 0191 (#2937 S4a): GATE-EXEC-ROUND-CAP owns the closure round; the judge brief cites the rule ID.
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("GATE-EXEC-ROUND-CAP states the cap-round fix, the one closure round and the escalation", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP -->")[1].split("\n")[1];
  for (const text of ["`judgeFix`", "composes `findings_present`", "a closure round (count cap+1)","`scope.closureRound`", "`closureRound: true`", "judge `defer` with a target issue", "Every round whose count equals cap+1 is a closure round", "diffs from `fromHead` whatever `--base` the caller passes", "`closure round: diff from <fromHead>`", "In every round after the cap round (count above the cap) any act item composes `blocked`", "the cap-round remedy clause", "ADR 0191", "When the deferral target resolves to the PR itself, the defer is not final, the round composes `blocked` with `severity_disagreement`, and the coordinator escalates"]) {
    assert.ok(rule.includes(text), text);
  }
  assert.doesNotMatch(rule, /\b(should|may|usually)\b/i);
  assert.ok(!rule.includes("Past the cap a new act item composes"));
  assert.ok(!rule.includes("unchanged in this slice"));
});

test("the judge brief carries the closure-round rule and cites the owning rule", async () => {
  const judge = await read("agents/judge.agent.md");
  assert.match(judge, /closure round \(work order `closureRound: true`, `GATE-EXEC-ROUND-CAP`\)/);
});
