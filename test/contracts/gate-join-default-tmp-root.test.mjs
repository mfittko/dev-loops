import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

test("the gate contract names the join without --tmp-root and states the classifier no-verdict retry", () => {
  const contract = read("skills/docs/gate-review-sub-loop-contract.md");
  const join = contract.split("\n").find((line) => line.startsWith("- Claude Code: the gate coordinator dispatches the wave's"));
  assert.ok(join);
  assert.doesNotMatch(join, /wait-for-units[^`]*--tmp-root <worktree>/);
  const retry = contract.split("\n").find((line) => line.startsWith("- Classifier no-verdict retry:"));
  assert.match(retry, /retries the same call with backoff within the 170-second bounded wait, then hands back with `operatorAction` naming the call/);
  assert.match(retry, /`operatorAction` is the call the coordinator retried, carried in a `report_blocked` result as its runnable `agentRemedy`/);
  assert.doesNotMatch(join, /hand-passed root makes a later pull refuse/);
});

test("the retrospective contract names the session transcript invocation", () => {
  assert.match(read("skills/docs/retrospective-checkpoint-contract.md"), /check-retro-tooling\.mjs \[--transcript <path>\]\.\.\. \[--json\]/);
});
