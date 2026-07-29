import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consolidateGateFanin,
  parseConsolidateFaninCliArgs,
} from "../../scripts/loop/consolidate-fanin.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { normalizeStructuredFindings } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { checkFanoutAngleCoverage } from "@dev-loops/core/loop/gate-fanin";

async function withFindingsDir(files, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test("parseConsolidateFaninCliArgs parses required + optional args", () => {
  const result = parseConsolidateFaninCliArgs([
    "--findings-dir", "/tmp/x",
    "--gate", "draft_gate",
    "--out", "/tmp/out.json",
    "--pr-checklist-matrix", "clean",
  ]);
  assert.equal(result.findingsDir, "/tmp/x");
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.out, "/tmp/out.json");
  assert.equal(result.prChecklistMatrix, "clean");
});

test("parseConsolidateFaninCliArgs rejects missing --findings-dir", () => {
  assert.throws(() => parseConsolidateFaninCliArgs([]), /findings-dir/);
});

test("parseConsolidateFaninCliArgs rejects invalid --gate", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--gate", "bogus_gate"]),
    /draft_gate or pre_approval_gate/,
  );
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("consolidateGateFanin consolidates 3 angle artifacts into the shapes downstream tools accept", async () => {
  await withFindingsDir(
    {
      "scope.json": { angle: "scope", verdict: "clean", findings: [] },
      "dry.json": {
        angle: "dry",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "bad dry", file: "src/a.mjs", line: 12 }],
      },
      "kiss.json": {
        angle: "kiss",
        verdict: "findings_present",
        findings: [{ severity: "worth-fixing-now", summary: "too clever" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, gate: "pre_approval_gate" });
      assert.equal(result.ok, true);
      assert.equal(result.gate, "pre_approval_gate");
      assert.equal(result.overallVerdict, "findings_present");
      assert.deepEqual(
        result.angles.sort((a, b) => a.angle.localeCompare(b.angle)),
        [
          { angle: "dry", verdict: "findings_present", findingCount: 1 },
          { angle: "kiss", verdict: "findings_present", findingCount: 1 },
          { angle: "scope", verdict: "clean", findingCount: 0 },
        ],
      );
      assert.deepEqual(result.severityCounts, { "must-fix": 1, "worth-fixing-now": 1, "defer": 0 });
      assert.equal(result.findings.length, 2);
      assert.deepEqual(result.ledger, result.findings);
      for (const finding of result.findings) {
        assert.ok(typeof finding.angle === "string" && finding.angle.length > 0);
      }

      // Validate the emitted shape against write-gate-findings-log.mjs's actual
      // documented enums/validation by feeding it straight through, end to end.
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-ledger-"));
      try {
        const written = await writeGateFindingsLog({
          repo: "owner/repo",
          pr: 1,
          gate: "pre_approval_gate",
          headSha: "abc1234567890abcdef000000000000000000000",
          verdict: result.overallVerdict,
          findings: JSON.stringify(result.ledger),
          tmpRoot,
        });
        assert.equal(written.ok, true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );
});

test("consolidateGateFanin writes --out as the nested findingsJson shape", async () => {
  await withFindingsDir(
    {
      "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] },
      "dry.json": { angle: "dry", verdict: "clean", findings: [] },
    },
    async (dir) => {
      const outPath = path.join(dir, "out", "findings.json");
      const result = await consolidateGateFanin({ findingsDir: dir, out: outPath });
      const written = JSON.parse(await readFile(outPath, "utf8"));
      assert.deepEqual(written, result.findingsJson);
      // Clean angles are preserved with an empty findings array, not dropped.
      assert.deepEqual(
        result.findingsJson.find((a) => a.angle === "dry"),
        { angle: "dry", verdict: "clean", findings: [] },
      );
      assert.equal(result.findingsJson.find((a) => a.angle === "scope").findings.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// pr-checklist-matrix mandatory-angle upsert
// ---------------------------------------------------------------------------

test("consolidateGateFanin upserts a clean pr-checklist-matrix angle when missing", async () => {
  await withFindingsDir(
    { "dry.json": { angle: "dry", verdict: "clean", findings: [] } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, prChecklistMatrix: "clean" });
      assert.deepEqual(
        result.angles.find((a) => a.angle === "pr-checklist-matrix"),
        { angle: "pr-checklist-matrix", verdict: "clean", findingCount: 0 },
      );
      assert.equal(result.overallVerdict, "clean");
    },
  );
});

test("consolidateGateFanin does not upsert pr-checklist-matrix when an artifact already covers it", async () => {
  await withFindingsDir(
    {
      "pr-checklist-matrix.json": {
        angle: "pr-checklist-matrix",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "checklist gap" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, prChecklistMatrix: "clean" });
      assert.equal(result.angles.length, 1);
      assert.equal(result.angles[0].findingCount, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// defer -> deferred disposition derivation
// ---------------------------------------------------------------------------

test("consolidateGateFanin derives a deferred disposition for defer-severity findings", async () => {
  await withFindingsDir(
    {
      "naming.json": {
        angle: "naming",
        verdict: "findings_present",
        findings: [{ severity: "defer", summary: "style nit" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, "defer");
      assert.equal(result.findings[0].disposition, "deferred");
    },
  );
});

// ---------------------------------------------------------------------------
// Fail-closed paths
// ---------------------------------------------------------------------------

test("consolidateGateFanin fails closed on a missing --findings-dir", async () => {
  await assert.rejects(
    () => consolidateGateFanin({ findingsDir: "/nonexistent/does-not-exist" }),
    /could not be read/,
  );
});

test("consolidateGateFanin fails closed on an empty --findings-dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-empty-"));
  try {
    await assert.rejects(() => consolidateGateFanin({ findingsDir: dir }), /contains no \*\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consolidateGateFanin fails closed on an unparseable artifact", async () => {
  await withFindingsDir({ "bad.json": "{ this is not json" }, async (dir) => {
    await assert.rejects(() => consolidateGateFanin({ findingsDir: dir }), /not valid JSON/);
  });
});

test("consolidateGateFanin fails closed on a missing angle", async () => {
  await withFindingsDir({ "bad.json": { verdict: "clean", findings: [] } }, async (dir) => {
    await assert.rejects(() => consolidateGateFanin({ findingsDir: dir }), /missing "angle"/);
  });
});

test("consolidateGateFanin fails closed on a missing verdict", async () => {
  await withFindingsDir({ "bad.json": { angle: "scope", findings: [] } }, async (dir) => {
    await assert.rejects(() => consolidateGateFanin({ findingsDir: dir }), /missing "verdict"/);
  });
});

test("consolidateGateFanin fails closed on an unknown severity", async () => {
  await withFindingsDir(
    { "bad.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "urgent", summary: "x" }] } },
    async (dir) => {
      await assert.rejects(() => consolidateGateFanin({ findingsDir: dir }), /unknown severity "urgent"/);
    },
  );
});

// End-to-end acceptance: the emitted findingsJson must survive the REAL
// upsert-checkpoint-verdict parsing (normalizeStructuredFindings) and the
// REAL mandatory-angle coverage check (checkFanoutAngleCoverage) — including
// the two shapes that previously failed: an all-clean fan-out and a clean
// mandatory angle contributing zero flat findings.
test("e2e: all-clean fan-out with pr-checklist-matrix upsert passes upsert-verdict parsing + coverage", async () => {
  await withFindingsDir(
    {
      "scope.json": { angle: "scope", verdict: "clean", findings: [] },
      "dry.json": { angle: "dry", verdict: "clean", findings: [] },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, prChecklistMatrix: "clean" });
      const normalized = normalizeStructuredFindings(result.findingsJson);
      assert.ok(Array.isArray(normalized), "nested shape must normalize (not be rejected as unrenderable)");
      const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(result.findingsJson, {
        mandatoryAngles: ["pr-checklist-matrix"],
        pool: ["scope", "dry", "pr-checklist-matrix"],
      });
      assert.deepEqual(missingMandatory, []);
      assert.deepEqual(foreignAngles, []);
      assert.equal(result.overallVerdict, "clean");
    },
  );
});

test("e2e: clean mandatory angle survives alongside findings-bearing angles", async () => {
  await withFindingsDir(
    {
      "pr-description.json": { angle: "pr-description", verdict: "clean", findings: [] },
      "coverage.json": {
        angle: "coverage",
        verdict: "findings_present",
        findings: [{ severity: "worth-fixing-now", summary: "gap" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      const normalized = normalizeStructuredFindings(result.findingsJson);
      assert.ok(Array.isArray(normalized));
      const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(result.findingsJson, {
        mandatoryAngles: ["pr-description"],
        pool: ["pr-description", "coverage"],
      });
      assert.deepEqual(missingMandatory, []);
      assert.deepEqual(foreignAngles, []);
    },
  );
});

test("--gate applies the worktree's configured blocking severities to the overall verdict", async () => {
  const cwdDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-cwd-"));
  const prevCwd = process.cwd();
  try {
    await writeFile(
      path.join(cwdDir, ".devloops"),
      "version: 1\ngates:\n  draft:\n    blockCleanOnFindingSeverities:\n      - must-fix\n      - worth-fixing-now\n",
      "utf8",
    );
    await withFindingsDir(
      {
        "scope.json": {
          angle: "scope",
          verdict: "findings_present",
          findings: [{ severity: "worth-fixing-now", summary: "w" }],
        },
      },
      async (dir) => {
        process.chdir(cwdDir);
        const gated = await consolidateGateFanin({ findingsDir: dir, gate: "draft_gate" });
        assert.equal(gated.overallVerdict, "findings_present");
        const ungated = await consolidateGateFanin({ findingsDir: dir });
        assert.equal(ungated.overallVerdict, "clean");
      },
    );
  } finally {
    process.chdir(prevCwd);
    await rm(cwdDir, { recursive: true, force: true });
  }
});
