import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { assertRuleOwned } from "./_rule-helpers.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";

// The full rule paragraph: from its marker to the next rule marker or heading.
function ruleBlock(content, id) {
  const start = content.indexOf(`<!-- rule: ${id} -->`);
  assert.ok(start !== -1, `${id} marker present`);
  const rest = content.slice(start + 1);
  const ends = [rest.indexOf("<!-- rule:"), rest.search(/\n#{2,4} /)].filter((i) => i !== -1);
  return rest.slice(0, Math.min(...ends));
}

test("BUILD-ONCE-SEED and FANOUT-DISPATCH-EMIT describe reference seeding via requiredReads, without the old verbatim-seeding clauses", () => {
  const contract = read(CONTRACT);
  for (const id of ["GATE-EXEC-BUILD-ONCE-SEED", "GATE-EXEC-FANOUT-DISPATCH-EMIT"]) {
    assertRuleOwned(id, CONTRACT);
    const block = ruleBlock(contract, id);
    assert.match(block, /requiredReads/, `${id} names requiredReads`);
    assert.match(block, /reference seed/i, `${id} names reference seeding`);
    assert.doesNotMatch(block, /seeded with that unit's `promptPath` bytes verbatim/);
    assert.doesNotMatch(block, /seed(ed)? .*verbatim with (that|the neutral) bundle/i);
  }
  assert.doesNotMatch(contract, /seeded with that unit's `promptPath` bytes verbatim/);
  assert.doesNotMatch(contract, /seed(ed)? .*verbatim with (that|the neutral) bundle/i);
});

test("contract forbids clipped/ellipsis evidence and requires a full referenced read", () => {
  const contract = read(CONTRACT);
  assert.match(contract, /MUST NOT (clip|truncate)[^.]*ellips/i);
  assert.match(contract, /read every required read in full/i);
});

test("contract: correctness MUST NOT depend on a provider cache hit", () => {
  assert.match(ruleBlock(read(CONTRACT), "GATE-EXEC-PRIME"), /MUST NOT depend on a provider cache hit/);
});

test("per-harness delivery: Pi and Claude relay only the work order; the child reads the evidence", () => {
  const contract = read(CONTRACT);
  const table = contract.slice(contract.indexOf("**Per-harness delivery.**"), contract.indexOf("**Content inlining.**"));
  const piRow = table.split("\n").find((line) => line.startsWith("| Code-driven Pi"));
  const claudeRow = table.split("\n").find((line) => line.startsWith("| Agent-driven Claude Code"));
  for (const row of [piRow, claudeRow]) {
    assert.ok(row, "delivery row present");
    assert.match(row, /work order/);
    assert.match(row, /reads? the (referenced )?evidence/i);
  }
});

test("review agent blocks on a missing, unreadable, or hash-mismatched required read", () => {
  const agent = read("agents/review.agent.md");
  assert.match(agent, /required: ?true/);
  assert.match(agent, /in full/i);
  assert.match(agent, /missing, unreadable,? or hash-mismatched/i);
  assert.match(agent, /emit-reviewer-blocked\.mjs/);
  assert.match(agent, /never judge from a summary or (a )?partial read/i);
});

test("ADR 0086 records reference seeding as an accepted amendment of ADR 0021", () => {
  const dir = path.join(repoRoot, "docs/decisions");
  const file = fs.readdirSync(dir).find((name) => name.startsWith("0086-"));
  assert.equal(file, "0086-gate-fanout-reference-seeded-work-orders.md");
  const adr = fs.readFileSync(path.join(dir, file), "utf8");
  assert.match(adr, /## Status\s+Accepted — \d{4}-\d{2}-\d{2}/);
  assert.match(adr, /Amends 0021/);
  assert.match(adr, /reference seed/i);
});
