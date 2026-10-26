import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

// ADR 0191 (#2937 S4a): GATE-EXEC-ROUND-CAP owns the closure round; the judge brief cites the rule ID.
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("GATE-EXEC-ROUND-CAP states the cap-round fix, the one closure round and the escalation", async () => {
  const contract = await read("skills/docs/gate-review-sub-loop-contract.md");
  const rule = contract.split("<!-- rule: GATE-EXEC-ROUND-CAP -->")[1].split("\n")[1];
  for (const text of ["`judgeFix`", "composes `findings_present`", "a closure round (count cap+1)","`scope.closureRound`", "`closureRound: true`", "judge `defer` with a target issue", "Every round whose count equals cap+1 is a closure round", "the closure round ignores `--base`","ADR 0191"]) {
    assert.ok(rule.includes(text), text);
  }
  assert.ok(!rule.includes("unchanged in this slice"));
});

test("the judge brief carries the closure-round rule and cites the owning rule", async () => {
  const judge = await read("agents/judge.agent.md");
  assert.match(judge, /closure round \(work order `closureRound: true`, `GATE-EXEC-ROUND-CAP`\)/);
});
