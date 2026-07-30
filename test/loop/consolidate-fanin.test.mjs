import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    "--ledger-out", "/tmp/ledger.json",
    "--pr-checklist-matrix", "clean",
  ]);
  assert.equal(result.findingsDir, "/tmp/x");
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.out, "/tmp/out.json");
  assert.equal(result.ledgerOut, "/tmp/ledger.json");
  assert.equal(result.prChecklistMatrix, "clean");
});

test("parseConsolidateFaninCliArgs rejects a whitespace-only --ledger-out value", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--ledger-out", "   "]),
    /non-empty path/,
  );
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
          findings: JSON.stringify(result.findings),
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

test("consolidateGateFanin writes --ledger-out as the flat findings shape (the --findings-file input write-gate-findings-log.mjs/post-gate-findings.mjs accept)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const ledgerPath = path.join(dir, "out", "ledger.json");
      const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: ledgerPath });
      const written = JSON.parse(await readFile(ledgerPath, "utf8"));
      assert.deepEqual(written, result.findings);
      assert.equal(result.findings.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// recommendation passthrough + length cap
// ---------------------------------------------------------------------------

test("a reviewer-provided recommendation survives into both findingsJson and the flat findings shape", async () => {
  await withFindingsDir(
    {
      "scope.json": {
        angle: "scope",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "x", recommendation: "do the thing" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.equal(result.findings[0].recommendation, "do the thing");
      assert.equal(
        result.findingsJson.find((a) => a.angle === "scope").findings[0].recommendation,
        "do the thing",
      );
    },
  );
});

test("a finding summary/recommendation over 2000 chars is truncated with a plain ellipsis suffix, never dropped", async () => {
  const longSummary = "s".repeat(2100);
  const longRecommendation = "r".repeat(2100);
  await withFindingsDir(
    {
      "scope.json": {
        angle: "scope",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: longSummary, recommendation: longRecommendation }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      const flat = result.findings[0];
      assert.equal(flat.summary.length, 2000);
      assert.ok(flat.summary.endsWith(" …"));
      const nested = result.findingsJson.find((a) => a.angle === "scope").findings[0];
      assert.equal(nested.recommendation.length, 2000);
      assert.ok(nested.recommendation.endsWith(" …"));
    },
  );
});

// ---------------------------------------------------------------------------
// pr-checklist-matrix mandatory-angle upsert
// ---------------------------------------------------------------------------

test("consolidateGateFanin rejects a --pr-checklist-matrix value other than \"clean\"", async () => {
  await withFindingsDir(
    { "dry.json": { angle: "dry", verdict: "clean", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, prChecklistMatrix: '{"angle":"scope","verdict":"findings_present","findings":[]}' }),
        /accepts only "clean"/,
      );
    },
  );
});

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

// ---------------------------------------------------------------------------
// Symlinked artifacts (must-fix regression: silently dropped before)
// ---------------------------------------------------------------------------

test("consolidateGateFanin includes a symlinked *.json artifact (not silently dropped)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-symlink-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-symlink-target-"));
  try {
    const targetPath = path.join(targetDir, "correctness-real.json");
    await writeFile(
      targetPath,
      JSON.stringify({ angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "auth bypass" }] }),
      "utf8",
    );
    await symlink(targetPath, path.join(dir, "correctness.json"));
    await writeFile(path.join(dir, "clean.json"), JSON.stringify({ angle: "clean-angle", verdict: "clean", findings: [] }), "utf8");

    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.overallVerdict, "findings_present");
    assert.equal(result.severityCounts["must-fix"], 1);
    assert.ok(result.angles.some((a) => a.angle === "correctness"), "symlinked angle must be present, not dropped");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("consolidateGateFanin fails closed on a dangling symlink *.json entry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-dangling-symlink-"));
  try {
    await symlink(path.join(dir, "does-not-exist-target.json"), path.join(dir, "dangling.json"));
    await assert.rejects(
      () => consolidateGateFanin({ findingsDir: dir }),
      /dangling\.json.*could not be resolved/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Duplicate angle names (must-fix regression: findings duplicated per file)
// ---------------------------------------------------------------------------

test("consolidateGateFanin fails closed on duplicate angle names across artifact files", async () => {
  await withFindingsDir(
    {
      "security.json": { angle: "security", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "a" }] },
      "security-round2.json": { angle: "security", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "b" }] },
    },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir }),
        /duplicate angle name.*"security"/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// --repo-root determinism + fail-closed config loading
// ---------------------------------------------------------------------------

test("--repo-root anchors config resolution regardless of process.cwd()", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-reporoot-"));
  const neutralCwd = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-neutral-cwd-"));
  const prevCwd = process.cwd();
  try {
    await writeFile(
      path.join(configDir, ".devloops"),
      "version: 1\ngates:\n  draft:\n    blockCleanOnFindingSeverities:\n      - must-fix\n      - worth-fixing-now\n",
      "utf8",
    );
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "worth-fixing-now", summary: "w" }] } },
      async (dir) => {
        process.chdir(neutralCwd);
        const overridden = await consolidateGateFanin({ findingsDir: dir, gate: "draft_gate", repoRoot: configDir });
        assert.equal(overridden.overallVerdict, "findings_present", "--repo-root's config must be honored, not process.cwd()'s");
        const usingCwd = await consolidateGateFanin({ findingsDir: dir, gate: "draft_gate" });
        assert.equal(usingCwd.overallVerdict, "clean", "omitting --repo-root falls back to process.cwd() (no .devloops there)");
      },
    );
  } finally {
    process.chdir(prevCwd);
    await rm(configDir, { recursive: true, force: true });
    await rm(neutralCwd, { recursive: true, force: true });
  }
});

test("--gate fails closed when this worktree's config could not be loaded/validated", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-badconfig-"));
  try {
    // Malformed YAML (unterminated flow mapping) makes loadDevLoopConfig
    // report a non-empty `errors` and fall back to the shipped defaults.
    await writeFile(path.join(configDir, ".devloops"), "gates: [this is not valid yaml\n", "utf8");
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, gate: "draft_gate", repoRoot: configDir }),
          /could not be fully loaded\/validated/,
        );
      },
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
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

// Regression (r2 must-fix): a blocked consolidation must FAIL CLOSED, never
// emit an all-clean findingsJson that silently discards real findings. Pair a
// findings-bearing artifact with each blocked/malformed variant.
test("blocked fan-in refuses to emit findingsJson/--out (fail closed), never an all-clean shape", async () => {
  // Each variant's detail message must be distinguishable: a "blocked"-verdict
  // artifact is a LEGAL reviewer signal (re-run the reviewer), never a schema
  // violation (fix the artifact) — see the input-validation regression below.
  const variants = {
    "blocked-verdict": {
      artifact: { angle: "scope", verdict: "blocked", findings: [] },
      detailPattern: /scope: reported verdict "blocked" — re-run that reviewer, then re-consolidate/,
    },
    "padded-severity": {
      artifact: {
        angle: "scope",
        verdict: "findings_present",
        findings: [{ severity: " must-fix ", summary: "padded" }],
      },
      detailPattern: /scope: angle 'scope' has a finding with invalid severity/,
    },
  };
  for (const [name, { artifact: badArtifact, detailPattern }] of Object.entries(variants)) {
    await withFindingsDir(
      {
        "correctness.json": {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "auth bypass" }],
        },
        "bad.json": badArtifact,
      },
      async (dir) => {
        const outPath = path.join(dir, "out", "findings.json");
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, out: outPath }),
          /fan-in is blocked/,
          `variant ${name} must fail closed`,
        );
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, out: outPath }),
          detailPattern,
          `variant ${name} must render its own distinct detail message`,
        );
        await assert.rejects(() => readFile(outPath, "utf8"), undefined, `variant ${name} must not write --out`);
      },
    );
  }
});

// Regression: a "blocked"-verdict artifact's message must be distinct from a
// genuinely schema-malformed artifact's, so an operator is steered toward
// re-running the reviewer rather than "fixing" a legal blocked signal.
test("blocked fan-in message distinguishes a reviewer-reported blocked verdict from a schema-malformed artifact", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "blocked", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir }),
        /scope: reported verdict "blocked" — re-run that reviewer, then re-consolidate/,
      );
    },
  );
});

test("--repo-root fails closed on a nonexistent directory and an empty value", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, gate: "draft_gate", repoRoot: path.join(dir, "no-such-root") }),
        /not an existing directory/,
      );
    },
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--repo-root", "   "]),
    /non-empty path/,
  );
});

test("--out rejects a whitespace-only value at parse time", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "   "]),
    /non-empty path/,
  );
});
