import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { composeReviewVerdict, listOpenActItems } from "@dev-loops/core/loop/gate-fanin";
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
        { index: 0, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "relevant" },
        { index: 1, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "relevant" },
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
    await fn({ run, ledgerPath: path.join(tmpDir, LEDGER), tmpDir });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const VERDICT = {
  specDigest, headSha: HEAD, contentDigest,
  decisions: [
    decision(0, "finding_conflicts", { conflictingCriteria: [criterionIds[0]] }),
    decision(1, "valid_compliant", { authorizedRemediation: "fix it", defectClass: "c", siteQuery: "q" }),
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

test("a pr_scope identity with a finding_conflicts sibling on scope:1 persists every finding with its judgeDisposition", async () => {
  const scopeSpec = { acceptanceCriteria: [], definitionOfDone: [], nonGoals: [], specKind: "pr_scope", scope: ["Fixes reload.", "- keep the build"] };
  const scopeIds = specCriterionIds(scopeSpec);
  assert.deepEqual(scopeIds, ["scope:0", "scope:1"]);
  const scopeDigest = computeSpecDigest(scopeSpec);
  const scopeDecision = (index, outcome, extra = {}) => ({ index, outcome, specDigest: scopeDigest, headSha: HEAD, contentDigest, checkedCriteria: scopeIds, rationale: "r", ...extra });
  const siblingVerdict = {
    specDigest: scopeDigest, headSha: HEAD, contentDigest,
    decisions: [
      scopeDecision(0, "valid_compliant", { authorizedRemediation: "fix it", defectClass: "c", siteQuery: "q" }),
      scopeDecision(1, "finding_conflicts", { conflictingCriteria: ["scope:1"] }),
    ],
  };
  await withCase({ siblingVerdict, identity: { specDigest: scopeDigest, headSha: HEAD, contentDigest, checkedCriteria: scopeIds } }, async ({ run, ledgerPath }) => {
    await run();
    const { findings } = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(findings.length, 2, "every finding is persisted");
    assert.deepEqual(findings.map((f) => f.judgeDisposition), ["act", "reject"]);
    assert.match(findings[1].judgeRationale, /^spec-authority finding_conflicts/);
  });
});

test("a cluster-keyed sibling decision covers every member; a conflicting member decision refuses", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-cluster-"));
  try {
    const judgeVerdict = path.join(tmpDir, "judge-verdict.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: HEAD,
      scopeDrift: { verdict: "within_scope", rationale: "in scope", driftedAreas: [] },
      dispositions: [{ index: 0, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "relevant" }],
    }), "utf8");
    const specAuthority = path.join(tmpDir, "identity.json");
    await writeFile(specAuthority, JSON.stringify({ specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds }), "utf8");
    const compliant = (index) => decision(index, "valid_compliant", { authorizedRemediation: "fix it", defectClass: "c", siteQuery: "q" });
    const run = () => writeGateFindingsLog({
      repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: HEAD, verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "gap", clusterId: 0 },
        { severity: "low", angle: "docs", summary: "same gap", clusterId: 0 },
      ]),
      judgeVerdict, specAuthority, tmpRoot: tmpDir,
    });
    const sibling = path.join(tmpDir, "spec-authority-verdict.json");
    await writeFile(sibling, JSON.stringify({ ...VERDICT, decisions: [compliant(0)] }), "utf8");
    await run();
    await access(path.join(tmpDir, LEDGER));
    await writeFile(sibling, JSON.stringify({ ...VERDICT, decisions: [compliant(0), decision(1, "finding_conflicts", { conflictingCriteria: [criterionIds[0]] })] }), "utf8");
    await assert.rejects(run(), /\[spec_authority_cluster_conflict\]/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

test("a spec_cannot_decide sibling verdict fails closed at the human-spec-decision state and writes no ledger", async () => {
  const siblingVerdict = { ...VERDICT, decisions: [VERDICT.decisions[0], decision(1, "spec_cannot_decide")] };
  await withCase({ siblingVerdict }, async ({ run, ledgerPath }) => {
    await assert.rejects(run(), /SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT: .* finding index\(es\) 1;/);
    await assert.rejects(access(ledgerPath));
  });
});

test("an evidence-only valid_compliant sibling decision leaves zero open act items in the ledger", async () => {
  const siblingVerdict = {
    ...VERDICT,
    decisions: [
      decision(0, "valid_compliant", { authorizedRemediation: "confirm from CI", remedyKind: "evidence_only" }),
      decision(1, "valid_compliant", { authorizedRemediation: "confirm from CI", remedyKind: "evidence_only" }),
    ],
  };
  await withCase({ siblingVerdict }, async ({ run, ledgerPath }) => {
    await run();
    const { findings } = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(findings.map((f) => f.remedyKind), ["evidence_only", "evidence_only"]);
    assert.equal(listOpenActItems(findings).length, 0);
    assert.equal(composeReviewVerdict("clean", findings), "clean");
  });
});

test("check-judge-decision and the ledger writer agree on matcher rejectedForms", async () => {
  const { main } = await import("../../scripts/loop/check-judge-decision.mjs");
  const matcher = (rejectedForms) => ({
    ...VERDICT,
    decisions: [
      VERDICT.decisions[0],
      decision(1, "valid_compliant", { authorizedRemediation: "fix it", defectClass: "c", siteQuery: "q", defectKind: "matcher", acceptedForms: ["1"], rejectedForms }),
    ],
  });
  for (const [rejectedForms, ok] of [[["", "abc"], true], [[" 12 "], true], [[], false], [["a", 5], false]]) {
    await withCase({ siblingVerdict: matcher(rejectedForms) }, async ({ run, tmpDir }) => {
      const out = [];
      const saved = process.exitCode;
      try {
        await main(["--file", path.join(tmpDir, "spec-authority-verdict.json")], { stdout: { write: (s) => out.push(s) }, stderr: { write() {} } });
      } finally {
        process.exitCode = saved;
      }
      assert.equal(JSON.parse(out.join("")).ok, ok);
      if (ok) await run();
      else await assert.rejects(run(), /failed validation/);
    });
  }
});
