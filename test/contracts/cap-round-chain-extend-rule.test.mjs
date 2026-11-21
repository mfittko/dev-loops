import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// Issue 3122 DoD: the contract rule and the ADR name the reviewer-only route (the behavior is pinned in test/loop).
test("GATE-EXEC-ROUND-CAP-CHAIN-EXTEND names the reviewer-only route, its binding flags and the chain-end baseline", () => {
  const rule = read("skills/docs/gate-review-sub-loop-contract.md").split("\n").find((line) => line.startsWith("`GATE-EXEC-ROUND-CAP-CHAIN-EXTEND`"));
  assert.ok(rule, "the rule line exists");
  assert.match(rule, /loop pre-push-delta --reviewer-only --repo <owner\/name> --pr <n> --baseline <start> --pr-head <head>/);
  assert.match(rule, /chain-end baseline/);
  assert.match(rule, /ADR 0255/);
});

test("ADR 0255 amends the remedy of ADR 0254 and the pre-push delta contract names the reviewer-only route", () => {
  assert.match(read("docs/decisions/0255-code-range-delta-without-fixer-plan.md"), /^Amends the remedy of \[ADR 0254\]/m);
  const contract = read("skills/docs/pre-pr-review-contract.md");
  for (const rule of ["PRE-PUSH-DELTA-TRIGGER", "PRE-PUSH-DELTA-PINNED-BASELINE", "PRE-PUSH-DELTA-RESULT", "PRE-PUSH-DELTA-INPUT-CAP-CHAIN", "PRE-PUSH-DELTA-EXIT-BOUND"]) {
    const line = contract.split("\n").find((l) => l.startsWith(`\`${rule}\``));
    assert.match(line, /reviewer-only/, `${rule} names the reviewer-only route`);
  }
});

// Issue 3437 DoD dod:2: the contract describes the CI-failed cap-round path.
test("GATE-EXEC-ROUND-CAP-CHAIN-EXTEND describes the CI-failed cap-round path with distinct recoveries", () => {
  const rule = read("skills/docs/gate-review-sub-loop-contract.md").split("\n").find((line) => line.startsWith("`GATE-EXEC-ROUND-CAP-CHAIN-EXTEND`"));
  assert.match(rule, /CI-failed cap-round path \(issue 3437\)/);
  assert.match(rule, /`ci_failed`/);
  assert.match(rule, /MUST start at that candidate, never at the cap-round head/);
  assert.match(rule, /`logic_commit_in_range` and `delta_range_mismatch` refusals return `recovery` naming the reviewer-only run at the start of the logic range/);
  assert.match(rule, /`no_cap_round_chain` returns `recovery` by case: `loop gate-coordination` when no cap round resolves/);
  assert.match(rule, /`git fetch origin <cap-round-head-sha>` when the cap-round head is not in this clone/);
  assert.match(rule, /Its `recovery` is `operator:` followed by the full procedure/);
  // The refusal list names the same four cases (the unfetched cap-round head is the fourth), so the rule does not contradict itself.
  assert.match(rule, /`no_cap_round_chain` \(four cases, as in the CI-failed paragraph below: no resolved cap round names `loop gate-coordination`[^;]*does not route back; no record at the cap-round head names the reviewer-only delta[^;]*; a non-covering sealed record at the cap-round head names only the replacement-PR restart;/);
  assert.match(rule, /the `no_cap_round_chain` case with no resolved cap round is the exception: coordination does not route back from it/);
  assert.match(rule, /A replacement PR is the operator recovery for an orphaned baseline, for a candidate or cap-round head outside the PR head's history, and for that non-covering record/);
});
