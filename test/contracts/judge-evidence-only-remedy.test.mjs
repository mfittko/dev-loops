import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { decideBashGate } from "@dev-loops/core/claude/hook-decisions";
import {
  checkRemediationScopes,
  computeContentDigest,
  computeSpecDigest,
  specCriterionIds,
  validateSpecAuthorityDecision,
} from "@dev-loops/core/loop/spec-authority";
import { main as checkMain } from "../../scripts/loop/check-judge-decision.mjs";

const HEAD = "abc1234567890abcdef000000000000000000000";
const SPEC = { acceptanceCriteria: ["Specs are green"], definitionOfDone: ["merged"], nonGoals: ["No rewrite"] };
const ctx = { specDigest: computeSpecDigest(SPEC), headSha: HEAD, contentDigest: computeContentDigest("x"), criterionIds: specCriterionIds(SPEC) };
const decision = (extra = {}) => ({
  index: 0, outcome: "valid_compliant", ...ctx, checkedCriteria: ctx.criterionIds, rationale: "r",
  authorizedRemediation: "Confirm the specs-green criterion from CI on the PR head.", ...extra,
});

test("an evidence-only valid_compliant decision needs no defectClass or siteQuery", () => {
  const out = validateSpecAuthorityDecision(decision({ remedyKind: "evidence_only" }), ctx);
  assert.equal(out.remedyKind, "evidence_only");
  assert.equal(out.defectClass, undefined);
});

test("a code-change valid_compliant decision without defectClass is refused with a typed error", () => {
  for (const extra of [{}, { remedyKind: "code_change" }]) {
    assert.throws(() => validateSpecAuthorityDecision(decision(extra), ctx), (e) => e.code === "spec_authority_decision_invalid" && e.decisionIndex === 0 && e.field === "defectClass");
  }
  assert.throws(() => validateSpecAuthorityDecision(decision({ defectClass: "c" }), ctx), (e) => e.field === "siteQuery");
});

test("the judge check CLI accepts evidence-only and names the decision and field of a malformed one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "judge-check-"));
  const run = async (decisions) => {
    const file = path.join(dir, "v.json");
    await writeFile(file, JSON.stringify({ decisions }));
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += chunk; return true; };
    try { await checkMain(["--file", file]); } finally { process.stdout.write = write; }
    return JSON.parse(out);
  };
  try {
    assert.deepEqual(await run([decision({ remedyKind: "evidence_only" })]), { ok: true, checked: 1 });
    const bad = await run([decision({ remedyKind: "evidence_only" }), decision({ index: 1 })]);
    assert.equal(bad.ok, false);
    assert.equal(bad.decisionIndex, 1);
    assert.equal(bad.field, "defectClass");
    assert.equal(checkRemediationScopes({ decisions: [{ outcome: "finding_conflicts" }] }), 0);
  } finally {
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the judge Bash gate allows the check line and the judge text names it", async () => {
  const line = "dev-loops-run scripts/loop/check-judge-decision.mjs --file /w/tmp/gate-judge/o-r/pr-1/r1/verdict.json";
  assert.equal(decideBashGate({ command: line, agentType: "judge" }).decision, "allow");
  assert.equal(decideBashGate({ command: `${line}; id`, agentType: "judge" }).decision, "deny");
  assert.equal(decideBashGate({ command: line.replace("/w/tmp/gate-judge/o-r", "/w/tmp/gate-judge/../x"), agentType: "judge" }).decision, "deny");
  const text = await readFile(new URL("../../agents/judge.agent.md", import.meta.url), "utf8");
  assert.match(text, /check-judge-decision\.mjs/);
  assert.match(text, /remedyKind: "evidence_only"/);
});
