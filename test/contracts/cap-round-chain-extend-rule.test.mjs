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
  // The MUST covers the plain reviewer-only run: the cover run starts at the cap-round head (issue 3443 delta review).
  assert.match(rule, /The plain reviewer-only delta MUST start at that candidate, never at the cap-round head, because a plain run at the cap-round head refuses/);
  assert.match(rule, /the cover run \(`--cover-uncovered`\) is the one reviewer-only run that starts at the cap-round head/);
  assert.match(rule, /`logic_commit_in_range` and `delta_range_mismatch` refusals return `recovery` naming the reviewer-only run at the start of the logic range/);
  assert.match(rule, /`no_cap_round_chain` returns `recovery` by case: `loop gate-coordination` when no cap round resolves/);
  assert.match(rule, /`git fetch origin <cap-round-head-sha>` when the cap-round head is not in this clone/);
  assert.match(rule, /Its `recovery` is `operator:` followed by the full procedure/);
  // The refusal list points at the CI-failed paragraph, which lists the cases once and names no count (issue 3443 folded the duplicate list), so the rule does not contradict itself.
  assert.match(rule, /`no_cap_round_chain` \(the cases are listed once in the CI-failed paragraph below; the unfetched cap-round head runs `git rev-parse --is-shallow-repository`/);
  assert.doesNotMatch(rule, /five cases/);
  // `history_unresolved` is a separate reason: the by-case list of `no_cap_round_chain` does not hold it.
  const byCase = rule.slice(rule.indexOf("`no_cap_round_chain` returns `recovery` by case:"), rule.indexOf("`history_unresolved` is a separate reason"));
  assert.ok(byCase.length > 0 && !byCase.includes("history_unresolved"), "the by-case list of no_cap_round_chain holds no history_unresolved case");
  assert.match(rule, /`history_unresolved` is a separate reason, not a case of `no_cap_round_chain`: its `recovery` is `git fetch origin <sha>`/);
  assert.match(rule, /the head-moving `operator:` form \(push one docs or tests commit to the PR branch, then rerun this command\) when the cap-round head is the PR head/);
  assert.match(rule, /the `no_cap_round_chain` case with no resolved cap round is the exception: coordination does not route back from it/);
  assert.match(rule, /A replacement PR is the operator recovery for an orphaned baseline, for a candidate or cap-round head outside the PR head's history, and, as the alternative to the cover run, for a non-covering record/);
  // Issue 3443 (ADR 0255 amendment): the cover run names the uncovered refs' recovery, and the empty-act-list statement is limited to the chain-end reviewer-only run.
  assert.match(rule, /the cover run \(`loop pre-push-delta --reviewer-only --cover-uncovered` over the cap-round head\.\.PR head, below\) when a sealed record at the cap-round head leaves act refs uncovered/);
  assert.match(rule, /A reviewer-only run with a chain-end baseline derives an empty act list \(ADR 0255\) and covers no act ref, so it is not the recovery for an uncovered ref/);
  assert.match(rule, /`history_unresolved`/);
  // Issue 3443 delta review: the exact set of records the cover run never replaces, the chain-start wording, the draft rule, the 16-combination limit and the compare-and-swap.
  assert.match(rule, /never replaces a cover record that is clearing, unsealed, unreadable or at the last invocation: the next invocation supersedes only its own sealed non-clearing cover record below the bound/);
  assert.doesNotMatch(rule, /a sealed `locally_clear` cover record is never replaced/);
  assert.match(rule, /a cap round with no sealed clearing chain start \(a record at the cap-round head or at a proven base-only merge of it\)/);
  assert.match(rule, /some sealed clearing chain end is the head or on its history/);
  assert.match(rule, /up to a limit of 16 combinations/);
  assert.match(rule, /refuses and writes nothing, with the input-run rerun as `recovery`, when a record or the next invocation differs from the snapshot/);
});
