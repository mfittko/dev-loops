// Doc- and code-drift guard: the reviewer-facing severity vocabulary is
// owned by SEVERITY_ORDER (@dev-loops/core/loop/gate-fanin). A partial
// future rename (e.g. adding/renaming a severity in code without updating
// the reviewer agent's own output schema, the sub-loop contract's
// classification list, or config.mjs's blockCleanOnFindingSeverities enum
// and resolveGateConfig's exact-match guard) must fail CI, not silently
// drift the vocabulary's surfaces apart.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LEGACY_SEVERITY_ALIASES, NON_DEFECT_SEVERITIES, SEVERITY_ORDER } from "@dev-loops/core/loop/gate-fanin";
import { BLOCKING_SEVERITY_SPELLINGS } from "@dev-loops/core/config";
import { VALID_DISPOSITIONS } from "../../scripts/github/write-gate-findings-log.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("agents/review.agent.md's findings-artifact severity enum has the same value SET as SEVERITY_ORDER", async () => {
  // Set equality, not exact order: SEVERITY_ORDER's order is an internal
  // urgency ranking (drives sort/upgrade-priority logic), while the doc's
  // enum is grouped for human readability (defects, then non-defects) — the
  // two orders are legitimately independent. What must never drift is which
  // values exist at all (a renamed/added/removed severity).
  const text = await readFile(`${repoRoot}agents/review.agent.md`, "utf8");
  const match = text.match(/"severity":\s*((?:"[a-z]+"(?:\s*\|\s*)?)+)/);
  assert.ok(match, "expected agents/review.agent.md to declare a \"severity\": \"a\" | \"b\" | ... enum line");
  const declared = [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...declared].sort(),
    [...SEVERITY_ORDER].sort(),
    "agents/review.agent.md's findings-artifact severity enum has drifted from SEVERITY_ORDER — update the agent source (never .claude/agents/review.md, which is generated)",
  );
});

test("skills/docs/gate-review-sub-loop-contract.md's classification list names every SEVERITY_ORDER value", async () => {
  const text = await readFile(`${repoRoot}skills/docs/gate-review-sub-loop-contract.md`, "utf8");
  const start = text.indexOf("- classify each finding:");
  assert.ok(start !== -1, "expected a '- classify each finding:' bullet in the contract doc");
  const nextBullet = text.indexOf("\n- ", start + 1);
  const paragraph = text.slice(start, nextBullet === -1 ? undefined : nextBullet);
  const missing = SEVERITY_ORDER.filter((s) => !paragraph.includes(`\`${s}\``));
  assert.deepEqual(
    missing,
    [],
    `skills/docs/gate-review-sub-loop-contract.md's classification bullet is missing SEVERITY_ORDER value(s): ${missing.join(", ")}`,
  );
});

test("config.mjs's BLOCKING_SEVERITY_SPELLINGS matches SEVERITY_ORDER's defect severities + LEGACY_SEVERITY_ALIASES' keys", () => {
  // blockCleanOnFindingSeverities is a DEFECT-severity-only vocabulary
  // (NON_DEFECT_SEVERITIES are excluded — see the schema's own doc comment)
  // plus every pre-rename legacy spelling whose CANONICAL target is a
  // defect severity (an alias whose target is a non-defect severity must
  // stay out of this defect-only enum). This derives the expected list from
  // the single-source-of-truth exports (@dev-loops/core/loop/gate-fanin)
  // instead of hand-copying the defect/non-defect partition a third time, so
  // a defect severity added to SEVERITY_ORDER (or a new legacy alias
  // resolving to one) that is not also added to BLOCKING_SEVERITY_SPELLINGS
  // fails here rather than leaving the schema enum and resolveGateConfig's
  // exact-match guard silently stale. A NON-defect severity added to
  // SEVERITY_ORDER must NOT be added to BLOCKING_SEVERITY_SPELLINGS — this
  // pin excludes it via NON_DEFECT_SEVERITIES rather than demanding it.
  const defectSeverities = SEVERITY_ORDER.filter((s) => !NON_DEFECT_SEVERITIES.has(s));
  const defectAliases = Object.keys(LEGACY_SEVERITY_ALIASES)
    .filter((alias) => defectSeverities.includes(LEGACY_SEVERITY_ALIASES[alias]));
  const expected = [...defectSeverities, ...defectAliases];
  assert.deepEqual(
    [...BLOCKING_SEVERITY_SPELLINGS].sort(),
    [...expected].sort(),
    "config.mjs's BLOCKING_SEVERITY_SPELLINGS has drifted from SEVERITY_ORDER's defect severities + their legacy aliases — widen BLOCKING_SEVERITY_SPELLINGS only for a new DEFECT severity or an alias resolving to one; a new NON-defect severity must stay excluded",
  );
});

test("skills/docs/gate-review-sub-loop-contract.md's disposition ledger enumeration matches VALID_DISPOSITIONS", async () => {
  const text = await readFile(`${repoRoot}skills/docs/gate-review-sub-loop-contract.md`, "utf8");
  const match = text.match(/disposition \(([a-z_,\- ]+?)\)/);
  assert.ok(match, "expected a 'disposition (a, b, ...)' enumeration in the contract doc's fan-in consolidation list");
  const declared = match[1].split(",").map((s) => s.trim().replace(/^or /, ""));
  assert.deepEqual(
    [...declared].sort(),
    [...VALID_DISPOSITIONS].sort(),
    "skills/docs/gate-review-sub-loop-contract.md's disposition enumeration has drifted from write-gate-findings-log.mjs's VALID_DISPOSITIONS",
  );
});
