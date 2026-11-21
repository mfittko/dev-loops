import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgainstBaseline, scanRefusals } from "../../scripts/loop/check-refusal-recovery.mjs";

test("flags a refusal without recovery and passes one with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refusal-"));
  mkdirSync(join(dir, "scripts/github"), { recursive: true });
  mkdirSync(join(dir, "scripts/loop"));
  mkdirSync(join(dir, "cli"));
  writeFileSync(join(dir, "scripts/github/a.mjs"), 'f({ ok: false, reason: "x" });\ng({ ok: false, recovery: "run y" });\n');
  const sites = scanRefusals(dir);
  assert.deepEqual(sites.map((s) => s.recovery), [false, true]);
  assert.equal(checkAgainstBaseline(sites, {}).length, 1);
  assert.equal(checkAgainstBaseline(sites, { "scripts/github/a.mjs": 1 }).length, 0);
});

test("the repo has no refusal path above the committed baseline", () => {
  const baseline = JSON.parse(readFileSync(new URL("../../docs/refusal-recovery-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(checkAgainstBaseline(scanRefusals(), baseline), []);
});
