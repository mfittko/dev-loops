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

// Old verbatim-seeding phrasings, matched against whitespace-collapsed text so
// a clause wrapped across lines still counts.
const OLD_VERBATIM_SEEDING = [
  /seeded with that unit's `promptPath` bytes verbatim/,
  /seed(ed)? [^.]*verbatim with (that|the neutral) bundle/i,
  /seed(ed)? [^.]*with (that|the neutral( context)?) bundle verbatim/i,
  /seed handed verbatim to every reviewer/i,
];
const collapse = (text) => text.replace(/\s+/g, " ");

// Structural claim check. A claim is a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities)
// that must co-occur in ONE sentence of the located block, so rewording keeps passing and a dropped literal
// or modality fails. `assertClaims` also proves both directions on the real block: a reworded copy (filler clause between tokens, sentence order reversed) passes,
// and removing a claim's last token makes exactly that claim fail.
const sentences = (text) => collapse(text).split(/(?<=[.!?:])\s+(?=[A-Z`*(|-])/);
// Polarity-safe literals: MUST must not match MUST NOT, compliant must not match non-compliant.
const POLARITY = { MUST: /\bMUST\b(?! NOT)/, compliant: /(?<!non-)\bcompliant\b/ };
const has = (s, t) => (POLARITY[t] ? POLARITY[t].test(s) : s.includes(t));
const missingClaims = (block, claims) => claims.filter((tokens) => !sentences(block).some((s) => tokens.every((t) => has(s, t))));
const reword = (block, claims) => sentences(block).map((s) => (claims.find((tokens) => tokens.every((t) => has(s, t)))?.slice(0, -1) ?? []).reduce((acc, t) => acc.replace(t, `${t} (as the contract records, without exception)`), s)).reverse().join(" ");
function assertClaims(block, claims, label) {
  assert.deepEqual(missingClaims(block, claims), [], `${label}: missing claim`);
  assert.deepEqual(missingClaims(reword(block, claims), claims), [], `${label}: a reworded copy must pass`);
  const swapped = collapse(block).replace(/\bMUST\b(?! NOT)/g, "MUST NOT");
  for (const tokens of claims.filter((c) => c.includes("MUST"))) assert.ok(missingClaims(swapped, claims).includes(tokens), `${label}: MUST to MUST NOT must fail ${tokens.join(" + ")}`);
  for (const tokens of claims) {
    const broken = collapse(block).split(tokens.at(-1)).join("");
    assert.ok(missingClaims(broken, claims).includes(tokens), `${label}: dropping ${tokens.at(-1)} must fail ${tokens.join(" + ")}`);
  }
}

test("BUILD-ONCE-SEED and FANOUT-DISPATCH-EMIT describe reference seeding via requiredReads, without the old verbatim-seeding clauses", () => {
  const contract = read(CONTRACT);
  for (const id of ["GATE-EXEC-BUILD-ONCE-SEED", "GATE-EXEC-FANOUT-DISPATCH-EMIT"]) {
    assertRuleOwned(id, CONTRACT);
    assertClaims(ruleBlock(contract, id), [["requiredReads", "reference seeding"]], id);
  }
  for (const pattern of OLD_VERBATIM_SEEDING) assert.doesNotMatch(collapse(contract), pattern);
});

test("the old pointer-seeded non-compliance clause is scoped to prefix pointers: reference seeding of the bulk evidence is compliant", () => {
  assertClaims(
    ruleBlock(read(CONTRACT), "GATE-EXEC-BRIEFING-PREFIX"),
    [["requiredReads", "GATE-EXEC-BUILD-ONCE-SEED", "compliant"]],
    "GATE-EXEC-BRIEFING-PREFIX",
  );
});

test("contract forbids clipped/ellipsis evidence and requires a full referenced read", () => {
  assertClaims(ruleBlock(read(CONTRACT), "GATE-EXEC-BUILD-ONCE-SEED"), [
    ["MUST NOT", "clip", "ellipsis"],
    ["MUST", "every required read", "in full"],
    ["summary", "never replaces"],
  ], "GATE-EXEC-BUILD-ONCE-SEED");
});

test("contract: correctness MUST NOT depend on a provider cache hit", () => {
  assertClaims(ruleBlock(read(CONTRACT), "GATE-EXEC-FIRST-WAVE-RELEASE"), [["MUST NOT", "provider cache hit"]], "GATE-EXEC-FIRST-WAVE-RELEASE");
});

test("contract: the first wave is released immediately, with no primer or lead-reviewer barrier", () => {
  assertRuleOwned("GATE-EXEC-FIRST-WAVE-RELEASE", CONTRACT);
  assertClaims(ruleBlock(read(CONTRACT), "GATE-EXEC-FIRST-WAVE-RELEASE"), [
    ["MUST release", "first reviewer wave", "immediately"],
    ["primer", "lead reviewer", "precedes", "wave"],
    ["optional", "non-semantic"],
    ["`cacheReuseVerified: false`", "verified reuse", "missing telemetry"],
  ], "GATE-EXEC-FIRST-WAVE-RELEASE");
});

test("the retired primer rules are gone from the contract and the registry; the identity guards stay registered", () => {
  const contract = read(CONTRACT);
  const registry = JSON.parse(read("skills/docs/required-rules.json")).requiredRules.map((r) => (typeof r === "string" ? r : r.id));
  for (const retired of ["GATE-EXEC-PRIME", "GATE-EXEC-PRIMER-EVIDENCE"]) {
    assert.equal(contract.includes(`<!-- rule: ${retired} -->`), false, `${retired} marker retired`);
    assert.equal(registry.includes(retired), false, `${retired} retired from required-rules.json`);
  }
  assert.doesNotMatch(contract, /primer-evidence/);
  for (const guard of ["GATE-EXEC-BRIEFING-PREFIX", "GATE-EXEC-ROUND-RETIREMENT", "GATE-EXEC-RESOLVED-ANGLE-EVIDENCE", "GATE-EXEC-FANOUT-DISPATCH-EMIT", "GATE-EXEC-CACHE-TELEMETRY"]) {
    assert.ok(registry.includes(guard), `${guard} stays registered`);
    assert.ok(contract.includes(`<!-- rule: ${guard} -->`), `${guard} stays owned by the contract`);
  }
});

test("per-harness delivery: Pi and Claude relay only the compact work-order reference; the child reads the evidence", () => {
  const contract = read(CONTRACT);
  const table = contract.slice(contract.indexOf("**Per-harness delivery.**"), contract.indexOf("**Content inlining.**"));
  const piRow = table.split("\n").find((line) => line.startsWith("| Code-driven Pi"));
  const claudeRow = table.split("\n").find((line) => line.startsWith("| Agent-driven Claude Code"));
  for (const row of [piRow, claudeRow]) {
    assert.ok(row, "delivery row present");
    assert.match(row, /`dispatchPrompt`/);
    assertClaims(row, [["pulls", "work order", "evidence"]], "delivery row");
  }
});

test("review agent blocks on a missing, unreadable, or hash-mismatched required read", () => {
  const agent = read("agents/review.agent.md");
  const bullet = agent.slice(agent.indexOf("**Required reads.**")).split("\n- ")[0];
  assert.ok(bullet.includes("`required: true`"), "names the manifest field");
  assertClaims(bullet, [
    ["`required: true`", "IN FULL"],
    ["missing", "unreadable", "hash-mismatched", "`emit-reviewer-blocked.mjs`"],
    ["never judge", "summary", "partial"],
  ], "review agent required reads");
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

test("`.adjacentCode` is an optional navigation aid on every prose surface, never a required full read", () => {
  for (const rel of [CONTRACT, "agents/review.agent.md", "skills/copilot-pr-followup/SKILL.md", "scripts/github/write-gate-context.mjs"]) {
    const text = collapse(read(rel));
    assert.doesNotMatch(text, /required `\.adjacentCode`|`\.adjacentCode` is required/, `${rel} must not require .adjacentCode`);
    assertClaims(text, [["`.adjacentCode`", "optional"]], `${rel} names .adjacentCode optional`);
  }
});
