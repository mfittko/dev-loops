import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { composeReviewVerdict } from "@dev-loops/core/loop/gate-fanin";
import { computeContentDigest, computeSpecDigest, specCriterionIds } from "@dev-loops/core/loop/spec-authority";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";

// The durable ledger carries the judge pass's spec-authority finding_conflicts
// reject, so the posted verdict and merge do not block on that finding.

const HEAD = "abc1234567890abcdef000000000000000000000";
const SPEC = { acceptanceCriteria: ["Ship the act-list check"], definitionOfDone: ["verify passes"], nonGoals: ["No judge rule change"] };
const specDigest = computeSpecDigest(SPEC);
const contentDigest = computeContentDigest("reviewed");
const criterionIds = specCriterionIds(SPEC);
const LEDGER = path.join("gate-findings", "owner-repo", "pr-42", `draft_gate-${HEAD}.json`);

function decision(index, outcome, extra = {}) {
  return { index, outcome, specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "r", ...extra };
}

async function withCase({ siblingVerdict, identity = { specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds } }, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-spec-authority-"));
  try {
    const judgeVerdict = path.join(tmpDir, "judge-verdict.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: HEAD,
      scopeDrift: { verdict: "within_scope", rationale: "in scope", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "act", rationale: "relevant" },
        { index: 1, disposition: "act", rationale: "relevant" },
      ],
    }), "utf8");
    if (siblingVerdict !== undefined) {
      await writeFile(path.join(tmpDir, "spec-authority-verdict.json"), JSON.stringify(siblingVerdict), "utf8");
    }
    const specAuthority = path.join(tmpDir, "identity.json");
    await writeFile(specAuthority, JSON.stringify(identity), "utf8");
    const run = () => writeGateFindingsLog({
      repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: HEAD, verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "scope", summary: "conflicts with the spec" },
        { severity: "low", angle: "docs", summary: "valid gap" },
      ]),
      judgeVerdict, specAuthority, tmpRoot: tmpDir,
    });
    await fn({ run, ledgerPath: path.join(tmpDir, LEDGER) });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const VERDICT = {
  specDigest, headSha: HEAD, contentDigest,
  decisions: [
    decision(0, "finding_conflicts", { conflictingCriteria: [criterionIds[0]] }),
    decision(1, "valid_compliant", { authorizedRemediation: "fix it" }),
  ],
};

test("a finding_conflicts finding judged act lands in the ledger as reject", async () => {
  await withCase({ siblingVerdict: VERDICT }, async ({ run, ledgerPath }) => {
    await run();
    const { findings } = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(findings.map((f) => f.judgeDisposition), ["reject", "act"]);
    assert.match(findings[0].judgeRationale, /^spec-authority finding_conflicts: rejected against the spec \(was relevance-act\)/);
    assert.equal(composeReviewVerdict("clean", [findings[0]]), "clean");
  });
});

test("an absent sibling spec-authority verdict keeps the judge dispositions", async () => {
  await withCase({}, async ({ run, ledgerPath }) => {
    await run();
    const { findings } = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(findings.map((f) => f.judgeDisposition), ["act", "act"]);
  });
});

test("a mismatched or invalid sibling spec-authority verdict fails closed and writes no ledger", async () => {
  const otherHead = "def1234567890abcdef000000000000000000000";
  for (const [siblingVerdict, pattern] of [
    [{ ...VERDICT, headSha: otherHead, decisions: VERDICT.decisions.map((d) => ({ ...d, headSha: otherHead })) }, /headSha .* does not match --spec-authority/],
    [{ ...VERDICT, decisions: [VERDICT.decisions[0]] }, /failed validation/],
  ]) {
    await withCase({ siblingVerdict }, async ({ run, ledgerPath }) => {
      await assert.rejects(run(), pattern);
      await assert.rejects(access(ledgerPath));
    });
  }
});
