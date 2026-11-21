import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const DOCS = ["skills/copilot-pr-followup/SKILL.md", "skills/docs/gate-review-sub-loop-contract.md"];

// Issue 3415: the gate procedure passes the plan file path, because inline plan JSON puts finding text on the command line.
for (const doc of DOCS) {
  test(`${doc} passes --carry-forward-plan-file in the Phase 2 emitter and Phase 3 fan-in lines, never inline plan JSON`, () => {
    const lines = read(doc).split("\n");
    const fileLines = lines.filter((line) => line.includes("--carry-forward-plan-file"));
    assert.ok(fileLines.some((line) => line.includes("--pending")), "Phase 2 emitter line");
    assert.ok(fileLines.some((line) => line.includes("--carried-angles")), "Phase 3 fan-in line");
    for (const line of lines) {
      assert.ok(!/--carry-forward-plan <json>/.test(line), `inline plan JSON in: ${line.slice(0, 120)}`);
    }
  });
}
