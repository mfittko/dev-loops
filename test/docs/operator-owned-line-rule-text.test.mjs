import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

import { OPERATOR_OWNED_LINES } from "../../packages/core/src/github/operator-owned-lines.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const ruleRow = (doc, id) => doc.split("\n").find((line) => line.includes(`<!-- rule: ${id} -->`)) ?? "";

test("OPERATOR-OWNED-LINE row names every registry entry label, the shared guard and the ceiling", () => {
  const row = ruleRow(read("skills/docs/decision-record-contract.md"), "OPERATOR-OWNED-LINE");
  assert.ok(row.length > 0);
  for (const entry of OPERATOR_OWNED_LINES) assert.ok(row.includes(entry.label), `row lacks ${entry.id}`);
  for (const text of ["guardCommentBodyNoIssuePrIds", "--standing-authorization", "standingAuthorization", "Ceiling"]) {
    assert.ok(row.includes(text), text);
  }
});

test("the Copilot operator-form actor policy names all three actors", () => {
  const doc = read("skills/docs/copilot-loop-state-graph.md");
  const rule = doc.slice(doc.indexOf("`COPILOT-STATE-BODY-DISPOSITION-RECORD`:"));
  const policy = rule.slice(0, rule.indexOf("\n\n###"));
  assert.match(policy, /Subagents, the fixer included, never post it/);
  assert.match(policy, /orchestrator \(main agent\) posts it only through a sanctioned comment wrapper \(`comment-issue.mjs` or `edit-comment.mjs`\) with `--standing-authorization`/);
  assert.match(policy, /human may always post it/);
  const merge = read("skills/docs/merge-preconditions.md");
  assert.match(merge, /subagents never post it, the orchestrator posts it\s+only through a comment wrapper with `--standing-authorization`, and the human may always post\s+it/);
});
