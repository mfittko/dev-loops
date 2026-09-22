import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";

import { consolidateFanin, checkFanoutAngleCoverage, applyJudgeDispositions } from "../src/loop/gate-fanin.mjs";
import { loadDevLoopConfig, resolveGateAngleContract } from "../src/config/config.mjs";

// ============================================================================
// #2307: the general-purpose HOLISTIC reviewer angle participates in fan-in +
// judge exactly like any other angle (AC3), and is specifically what catches
// a cross-cutting defect class the fixed named angles miss (AC4). AC1/AC2
// (default angle set membership, dispatch as its own unit, un-briefed/
// spec-driven prompt contract) are covered in packages/core/test/config.test.mjs.
// ============================================================================

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("holistic reviewer angle — fan-in participation (#2307, AC3)", () => {
  test("a holistic finding flows through consolidateFanin like any angle, with a DERIVED (not input-set) disposition", () => {
    const angleResults = [
      { angle: "correctness", verdict: "clean", findings: [] },
      { angle: "scope", verdict: "clean", findings: [] },
      {
        angle: "holistic",
        verdict: "findings_present",
        findings: [{ severity: "medium", summary: "cross-cutting: X and Y disagree", file: "src/a.mjs", line: 1 }],
      },
    ];
    const result = consolidateFanin({ angleResults });
    const holisticFinding = result.findings.find((f) => f.angle === "holistic");
    assert.ok(holisticFinding, "the holistic angle's finding must appear in the consolidated flat findings");
    assert.equal(holisticFinding.summary, "cross-cutting: X and Y disagree");
    // Dispositions are DERIVED from severity (deriveDisposition), never set on
    // the input: this finding's input carries no `disposition` field at all,
    // yet the consolidated entry has one — proving it was computed, not passed
    // through. medium sits outside the default blockCleanOnFindingSeverities
    // (["high"]), so deriveDisposition resolves it to "deferred".
    assert.equal(Object.prototype.hasOwnProperty.call(angleResults[2].findings[0], "disposition"), false);
    assert.equal(holisticFinding.disposition, "deferred");
  });

  test("a holistic finding gets a judge disposition (act/defer/reject) on merits, same as any other angle (#2307, AC3/DoD)", () => {
    const angleResults = [
      {
        angle: "holistic",
        verdict: "findings_present",
        findings: [{ severity: "high", summary: "cross-cutting: config field read but never written", file: "src/reader.mjs", line: 12 }],
      },
      {
        angle: "holistic",
        verdict: "findings_present",
        findings: [{ severity: "low", summary: "cross-cutting: naming drifts between two related modules", file: "src/b.mjs", line: 3 }],
      },
    ];
    const { findings } = consolidateFanin({ angleResults });
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.angle === "holistic"));

    const judgeVerdict = {
      headSha: "abc123",
      scopeDrift: { verdict: "within_scope", rationale: "diff matches the stated AC", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "act", rationale: "the missing write is a real AC-relevant defect named in criterion 1", criterion: "AC-1" },
        {
          index: 1,
          disposition: "defer",
          rationale: "valid but out of this PR's scope; track separately",
          criterion: "Non-goal 2",
          followUpDraft: { title: "Align naming across b.mjs and its counterpart", body: "## Summary\nFollow up on the holistic naming-drift finding." },
        },
      ],
    };

    const { findings: enriched } = applyJudgeDispositions(findings, judgeVerdict);

    // The act-disposed holistic finding: proves a holistic finding flows
    // through the judge relevance axis exactly like any other angle's finding.
    assert.equal(enriched[0].judgeDisposition, "act");
    assert.equal(typeof enriched[0].judgeRationale, "string");
    assert.ok(enriched[0].judgeRationale.length > 0);
    // the severity-derived disposition is LEFT INTACT — the judge axis is
    // complementary, not a replacement (high sits in the default
    // blockCleanOnFindingSeverities, so it derived to "accepted-for-fix").
    assert.equal(enriched[0].disposition, "accepted-for-fix");

    // The defer-disposed holistic finding: same axis, different merit-based
    // outcome, carrying the required follow-up draft.
    assert.equal(enriched[1].judgeDisposition, "defer");
    assert.ok(enriched[1].judgeRationale.length > 0);
    assert.equal(enriched[1].disposition, "deferred");
    assert.deepEqual(enriched[1].followUpDraft, {
      title: "Align naming across b.mjs and its counterpart",
      body: "## Summary\nFollow up on the holistic naming-drift finding.",
    });
  });

  test("holistic is NOT rejected as a foreign angle: it is a member of the configured gate angle pool", async () => {
    const { config, errors } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    assert.deepEqual(errors, []);
    for (const gate of /** @type {const} */ (["draft", "preApproval"])) {
      const { pool } = resolveGateAngleContract(config, gate);
      assert.ok(pool.includes("holistic"), `${gate}: "holistic" must be in the resolved angle pool (in-pool = non-foreign)`);
      // checkFanoutAngleCoverage is the exact provenance-membership check the
      // write/read paths use to reject a foreign angle — pin that a recorded
      // "holistic" entry never lands in its foreignAngles output for this pool.
      const { foreignAngles } = checkFanoutAngleCoverage([{ angle: "holistic" }], { pool });
      assert.equal(foreignAngles.includes("holistic"), false, `${gate}: holistic must not be flagged foreign`);
    }
  });
});

// This is a DETERMINISTIC FAN-IN PROXY: it proves a holistic finding drives
// the round verdict through consolidateFanin. The behavioral claim that the
// holistic prompt actually catches the cross-cutting defect is validated by
// real gate runs, not by this test — a model run is not deterministic in CI.
describe("holistic reviewer angle — catches a cross-cutting class the fixed angles miss (#2307, AC4)", () => {
  test("the fixed named angles all return clean, but holistic's cross-cutting finding flips the round to findings_present", () => {
    // Deterministic fixture: no single named angle owns this defect — it only
    // surfaces by reading the WHOLE diff holistically (e.g. a mismatch between
    // two files each fixed-angle review only sees in isolation).
    const angleResults = [
      { angle: "correctness", verdict: "clean", findings: [] },
      { angle: "scope", verdict: "clean", findings: [] },
      { angle: "coverage", verdict: "clean", findings: [] },
      {
        angle: "holistic",
        verdict: "findings_present",
        findings: [{
          severity: "high",
          summary: "cross-cutting: the new config field is read in src/reader.mjs but never written by src/writer.mjs — no single angle's lens covers both files",
          file: "src/reader.mjs",
          line: 12,
        }],
      },
    ];
    const result = consolidateFanin({ angleResults });
    // Without holistic, every fixed angle reports clean and the round would
    // resolve "clean" — holistic is what catches the class the fixed angles
    // miss, so the overall verdict must be findings_present BECAUSE of it.
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.counts.blocking, 1);
    const holisticFinding = result.findings.find((f) => f.angle === "holistic");
    assert.ok(holisticFinding, "the holistic finding must be present in the consolidated flat findings");
    assert.equal(holisticFinding.severity, "high");
    assert.equal(holisticFinding.disposition, "accepted-for-fix");
    // Every other angle stays clean — pins that holistic alone drove the verdict.
    assert.deepEqual(
      result.findings.filter((f) => f.angle !== "holistic"),
      [],
    );
  });
});
