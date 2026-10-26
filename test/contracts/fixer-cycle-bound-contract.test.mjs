// GATE-EXEC-FIXER-CYCLE-BOUND (ADR 0188): no agent, skill or orchestrator brief sets a fixed fixer-cycle cap.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const NUMBER = String.raw`(?:\d+|one|two|three|four|five|six)`;
const FIXED_CAP = new RegExp(
  [
    String.raw`(?:max(?:imum)?|at most|up to|no more than|limit(?:ed)? to|capped at)\s+${NUMBER}\s+fixer[- ]cycles?`,
    String.raw`\b${NUMBER}\s+fixer[- ]cycles?\s+(?:max|cap|limit)`,
    String.raw`fixer[- ]cycle\s+(?:cap|limit)\s+(?:of|is|=)\s*${NUMBER}`,
  ].join("|"),
  "i",
);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test("FIXED_CAP matches the fixed-cap phrases it guards against", () => {
  assert.match("at most 2 fixer cycles", FIXED_CAP);
  assert.match("fixer cycle cap of 3", FIXED_CAP);
});

test("no agent, skill or brief imposes a fixed fixer-cycle cap", async () => {
  const briefs = (await readdir(path.join(repoRoot, "scripts/loop"))).filter((n) => n.includes("brief")).map((n) => path.join(repoRoot, "scripts/loop", n));
  const files = [...(await walk(path.join(repoRoot, "agents"))), ...(await walk(path.join(repoRoot, "skills"))), ...briefs].filter((f) => /\.(md|mjs)$/.test(f));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = (await readFile(file, "utf8")).replace(/\s+/g, " ");
    assert.doesNotMatch(text, FIXED_CAP, path.relative(repoRoot, file));
  }
});

test("the gate contract carries no retry-cycle maximum", async () => {
  const text = await readFile(path.join(repoRoot, "skills/docs/gate-review-sub-loop-contract.md"), "utf8");
  assert.doesNotMatch(text, /Maximum retry cycles/i);
});

test("the gate contract states the fixer-cycle bound", async () => {
  const text = (await readFile(path.join(repoRoot, "skills/docs/gate-review-sub-loop-contract.md"), "utf8")).replace(/\s+/g, " ");
  assert.match(text, /<!-- rule: GATE-EXEC-FIXER-CYCLE-BOUND -->/);
  assert.match(text, /`GATE-EXEC-FIXER-CYCLE-BOUND`: No contract, agent brief or orchestrator brief sets a fixed fixer-cycle cap\. .{0,120}new `high` finding, .{0,20}size-band growth past the forecast .{0,20}closure-only round cap/);
});
