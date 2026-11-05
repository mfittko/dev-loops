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
  for (const rule of ["PRE-PUSH-DELTA-TRIGGER", "PRE-PUSH-DELTA-PINNED-BASELINE", "PRE-PUSH-DELTA-RESULT", "PRE-PUSH-DELTA-INPUT-CAP-CHAIN"]) {
    const line = contract.split("\n").find((l) => l.startsWith(`\`${rule}\``));
    assert.match(line, /reviewer-only/, `${rule} names the reviewer-only route`);
  }
});
