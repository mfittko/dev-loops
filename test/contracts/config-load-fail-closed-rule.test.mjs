import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CALLER = /\bloadDevLoopConfig(Strict)?\b/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith(".mjs")) out.push(rel);
  }
  return out;
}

function ruleRows() {
  const doc = readFileSync(path.join(repoRoot, "skills/docs/artifact-authority-contract.md"), "utf8");
  const start = doc.indexOf("<!-- rule: CONFIG-LOAD-FAIL-CLOSED -->");
  assert.ok(start >= 0, "CONFIG-LOAD-FAIL-CLOSED rule is missing from the artifact authority contract");
  const rest = doc.slice(start);
  const end = rest.search(/\n## /u);
  const rows = new Map();
  const dupes = [];
  for (const line of rest.slice(0, end === -1 ? undefined : end).split("\n")) {
    const match = /^\| `([^`]+)` \| (.+) \|$/u.exec(line);
    if (!match) continue;
    if (rows.has(match[1])) dupes.push(match[1]);
    rows.set(match[1], match[2]);
  }
  assert.deepEqual(dupes, [], `duplicate CONFIG-LOAD-FAIL-CLOSED rows: ${dupes.join(", ")}`);
  return rows;
}

test("CONFIG-LOAD-FAIL-CLOSED is registered in required-rules.json", () => {
  const rules = JSON.parse(readFileSync(path.join(repoRoot, "skills/docs/required-rules.json"), "utf8"));
  assert.ok(rules.requiredRules.some((r) => r.id === "CONFIG-LOAD-FAIL-CLOSED"));
});

test("every loadDevLoopConfig caller under scripts/ and cli/ has exactly one decision row", () => {
  const rows = ruleRows();
  const callers = [...walk("scripts"), ...walk("cli")].filter((f) => CALLER.test(readFileSync(path.join(repoRoot, f), "utf8")));
  assert.ok(callers.length > 0);
  const missing = callers.filter((f) => !rows.has(f));
  assert.deepEqual(missing, [], `callers without a CONFIG-LOAD-FAIL-CLOSED row: ${missing.join(", ")}`);
  const stale = [...rows.keys()].filter((f) => !callers.includes(f));
  assert.deepEqual(stale, [], `rows for files that do not call loadDevLoopConfig: ${stale.join(", ")}`);
});
