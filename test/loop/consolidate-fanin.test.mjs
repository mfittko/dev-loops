import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consolidateGateFanin,
  parseConsolidateFaninCliArgs,
} from "../../scripts/loop/consolidate-fanin.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { normalizeStructuredFindings, renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { checkFanoutAngleCoverage } from "@dev-loops/core/loop/gate-fanin";

// Drive the REAL renderer upsert-checkpoint-verdict.mjs itself uses — the
// structured findings sub-block is what enforcePostedCommentLimit bounds at
// 2000 chars (and throws above), not the whole comment body (which also
// carries the header/digest/next-action text and is always > 2000 chars for
// a wide round). "renders" therefore means "does not throw", matching this
// file's own pre-existing convention (see the "large fan-ins are budgeted…"
// test below).
function assertRendersWithoutThrowing(findingsJson) {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    verdict: "findings_present",
    findingsSummary: "digest",
    nextAction: "fix",
    blockCleanOnFindingSeverities: ["must-fix"],
    structuredFindings: findingsJson,
  });
  assert.ok(typeof body === "string" && body.length > 0);
}

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

// Regression: the under-budget result shape is unchanged by the render-budget
// split — same keys, same values, and critically NO "commentBudgetExceeded"
// field at all (not even `false`) for a round that fits. Asserted against the
// exact literal shape rather than a partial match, so an accidental shape
// change on the unaffected path fails this test.
test("consolidateGateFanin under-budget output is byte-identical to the pre-split shape (no commentBudgetExceeded field)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.deepEqual(Object.keys(result), ["ok", "angles", "findingsJson", "findings", "severityCounts", "overallVerdict"]);
      assert.equal("commentBudgetExceeded" in result, false);
      assert.deepEqual(result, {
        ok: true,
        angles: [{ angle: "scope", verdict: "findings_present", findingCount: 1 }],
        findingsJson: [{
          angle: "scope",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "x", disposition: "accepted-for-fix" }],
        }],
        findings: [{ severity: "must-fix", angle: "scope", summary: "x", disposition: "accepted-for-fix" }],
        severityCounts: { "must-fix": 1, "worth-fixing-now": 0, defer: 0 },
        overallVerdict: "findings_present",
      });
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

// The consumer bounds the WHOLE rendered --findings-json block at 2000 chars
// and fails closed above it — so a large fan-in must be shrunk as a whole,
// not just per field. Prove acceptance by driving the REAL renderer.
test("large fan-ins are budgeted so upsert-verdict's whole-block render bound accepts them", async () => {
  const { renderGateReviewCommentBody } = await import("../../scripts/github/upsert-checkpoint-verdict.mjs");
  const files = {};
  for (let i = 0; i < 6; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: [
        { severity: "worth-fixing-now", summary: `finding ${i}: ${"x".repeat(1500)}`, file: `src/f${i}.mjs`, line: i + 1 },
      ],
    };
  }
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    // Must not throw the fail-closed length error:
    const body = renderGateReviewCommentBody({
      gate: "pre_approval_gate",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      verdict: "findings_present",
      findingsSummary: "digest",
      nextAction: "fix",
      blockCleanOnFindingSeverities: [],
      structuredFindings: result.findingsJson,
    });
    assert.ok(typeof body === "string" && body.length > 0);
  });
});

// Regression for a real reported false-negative: many SMALL findings, each
// carrying "file" + "line" + "disposition", whose per-finding decoration
// (path length, digits(line), the disposition wrap) an arithmetic size
// estimate can under-count without reproducing the renderer's exact
// formatting. Fit is now measured by actually rendering the candidate (see
// fitsRenderBudget), so this can no longer under-count: whatever
// "commentBudgetExceeded" says must match what the real renderer accepts.
// Reverting to an estimate-based check (even a well-tuned one) risks
// silently reintroducing this exact false negative.
// Regression for the estimate-vs-render false-negative defect class itself
// (not just "is the final shape renderable" — a fixture that resolves to the
// marker tier under BOTH an arithmetic estimate and the real renderer never
// exercises the discriminating branch). This fixture is a proven false
// negative under the PRIOR arithmetic estimator (estimateRenderSize, 1800
// budget from 068bc979): 34 must-fix findings with a trivial 3-char summary
// ("aaa"), short file ("src/a.mjs") and line (100+j) estimate at 1799 chars
// (fits comfortably under 1800) but the REAL renderer's structured-findings
// block is 2002 chars (per-finding decoration — severity/file/line/
// disposition prefixes — not summary length, pushes it over) and throws.
// The prior estimator would therefore have shipped this round's 34 RAW
// findings unmarked with ok:true and no commentBudgetExceeded — exactly the
// defect this render-based rewrite exists to eliminate. Reverting
// fitsRenderBudget to that estimate fails the first assertion below (it
// would report commentBudgetExceeded as falsy).
test("a false-negative-under-estimation fixture is correctly flagged over budget by the real renderer", async () => {
  const FINDINGS_PER_ANGLE = 34;
  const files = { "angle-a.json": {
    angle: "angle-a",
    verdict: "findings_present",
    findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
      severity: "must-fix",
      summary: "aaa",
      file: "src/a.mjs",
      line: 100 + j,
    })),
  } };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.commentBudgetExceeded, true);
    // The marked shape this CLI actually emits must render.
    assertRendersWithoutThrowing(result.findingsJson);
    // Prove the RAW (unmarked) shape — what an arithmetic estimate would have
    // shipped unmarked, since it estimates this fixture as under budget —
    // really is unrenderable, pinning the false-negative reproduction itself.
    const rawFindingsJson = [{
      angle: "angle-a",
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "must-fix",
        summary: "aaa",
        disposition: "accepted-for-fix",
        file: "src/a.mjs",
        line: 100 + j,
      })),
    }];
    assert.throws(
      () => renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "0123456789abcdef0123456789abcdef01234567",
        verdict: "findings_present",
        findingsSummary: "digest",
        nextAction: "fix",
        blockCleanOnFindingSeverities: ["must-fix"],
        structuredFindings: rawFindingsJson,
      }),
      /exceeds \d+ chars/,
    );
  });
});

// Near-boundary UNDER-budget companion: a round that really does fit must
// stay raw/unmarked (commentBudgetExceeded absent) and render as-is —
// unconditionally, not only "if the marker path wasn't taken" — so a
// reversion that starts marking everything (or estimating too
// conservatively) fails this half of the pair too.
test("a near-boundary under-budget round stays raw/unmarked and renders", async () => {
  const files = { "angle-a.json": {
    angle: "angle-a",
    verdict: "findings_present",
    findings: Array.from({ length: 10 }, (_, j) => ({
      severity: "must-fix",
      summary: `tiny finding ${j}`,
      file: `src/module/nested/path/file${j}.mjs`,
      line: 123 + j,
    })),
  } };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.commentBudgetExceeded, undefined);
    assert.equal(result.findingsJson[0].findings.length, 10);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Regression for the fan-in disposition ledger vs. gate-comment render budget
// split: a round too large to render even at minimum summary length must
// still write a COMPLETE --ledger-out and succeed (ok: true, no throw — the
// CLI's exit code is derived from result.ok, so this also proves exit 0); each
// angle's findings in --out are replaced with one budget-marker finding, but
// the REAL angle set and each angle's REAL verdict survive — a mandatory
// angle (e.g. draft_gate's "pr-description") must still be present and no
// foreign angle name is introduced, or upsert-checkpoint-verdict.mjs's
// fanout_fanin mandatory-angle/pool validation rejects the whole verdict
// (the exact failure this split exists to remove). One angle carries MIXED
// severities so the highest-wins marker severity/disposition derivation is
// actually pinned (a single-severity fixture leaves it unverified). Proven
// against the REAL normalizeStructuredFindings/checkFanoutAngleCoverage/
// renderGateReviewCommentBody functions upsert-checkpoint-verdict.mjs itself
// uses, not a re-implementation. Reverting the fix (throwing, collapsing to
// one foreign section, or dropping "disposition") fails this test.
test("a fan-in too large to render at minimum summary length still writes a complete ledger and exits 0, preserving the real angle set/verdicts/renderability", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const angleNames = ["scope", "coverage", "correctness", "ci-guard", "contract-surface", "link-check", "config-drift", "gate-evidence"];
  const MIXED_ANGLE = "scope"; // 28 worth-fixing-now + 1 must-fix + 1 defer
  const PINNED_SUMMARY = "unshrunk-marker-59f2 the exact original finding text must survive in the ledger";
  const files = { "pr-description.json": { angle: "pr-description", verdict: "clean", findings: [] } };
  for (const [i, angle] of angleNames.entries()) {
    const findings = Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
      severity: "worth-fixing-now",
      summary: j === 0 && angle === MIXED_ANGLE ? PINNED_SUMMARY : `finding ${angle}-${j} ${"y".repeat(200)}`,
      file: `src/f${angle}.mjs`,
      line: j + 1,
    }));
    if (angle === MIXED_ANGLE) {
      findings[1] = { ...findings[1], severity: "must-fix" };
      findings[2] = { ...findings[2], severity: "defer" };
    }
    files[`angle${i}.json`] = { angle, verdict: "findings_present", findings };
  }
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    const ledgerPath = path.join(dir, "out", "ledger.json");
    // No --gate: keep consolidateFanin's own default blockCleanOnFindingSeverities
    // (["must-fix"]) so the disposition assertions below (worth-fixing-now →
    // deferred, must-fix → accepted-for-fix) are not entangled with this
    // worktree's own repo config. Mandatory-angle/pool coverage is proven
    // separately below via a direct checkFanoutAngleCoverage call.
    const result = await consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath });

    // Succeeds (no throw) with the fail-closed signal replaced by an
    // explicit flag — this is what makes the CLI exit 0.
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);

    // The ledger is COMPLETE: every finding from every angle, unaffected by
    // the comment budget — including the exact, un-shrunk summary TEXT (not
    // just a count) for a specific finding.
    const totalFindings = angleNames.length * FINDINGS_PER_ANGLE;
    assert.equal(result.findings.length, totalFindings);
    assert.deepEqual(result.severityCounts, { "must-fix": 1, "worth-fixing-now": totalFindings - 2, defer: 1 });
    const writtenLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(writtenLedger, result.findings);
    assert.equal(writtenLedger.length, totalFindings);
    const pinnedLedgerEntry = writtenLedger.find((f) => f.summary === PINNED_SUMMARY);
    assert.ok(pinnedLedgerEntry, "the ledger must carry the exact, un-shrunk original summary text");
    assert.equal(pinnedLedgerEntry.angle, MIXED_ANGLE);

    // --out keeps the REAL angle set (mandatory "pr-description" included,
    // no foreign angle) and each angle's REAL verdict — only the findings
    // are collapsed to one budget-marker finding per angle, which still
    // carries a severity-derived "disposition" like every other findingsJson
    // finding.
    const writtenOut = JSON.parse(await readFile(outPath, "utf8"));
    assert.deepEqual(writtenOut, result.findingsJson);
    assert.equal(writtenOut.length, angleNames.length + 1);
    const byAngle = new Map(writtenOut.map((a) => [a.angle, a]));
    assert.ok(byAngle.has("pr-description"));
    assert.deepEqual(byAngle.get("pr-description"), { angle: "pr-description", verdict: "clean", findings: [] });
    for (const angle of angleNames) {
      const section = byAngle.get(angle);
      assert.ok(section, `expected angle "${angle}" to survive budget marking`);
      assert.equal(section.verdict, "findings_present"); // real verdict, not collapsed
      assert.equal(section.findings.length, 1);
      const marker = section.findings[0].summary;
      assert.match(marker, new RegExp(`${FINDINGS_PER_ANGLE} finding\\(s\\)`));
      assert.match(marker, /see the disposition ledger/);
      if (angle === MIXED_ANGLE) {
        // Highest-severity-wins: must-fix beats worth-fixing-now/defer, and
        // the marker's own disposition matches that severity's derivation
        // (accepted-for-fix — the default blockCleanOnFindingSeverities is
        // ["must-fix"]).
        assert.match(marker, /must-fix: 1/);
        assert.match(marker, /worth-fixing-now: 28/);
        assert.match(marker, /defer: 1/);
        assert.equal(section.findings[0].severity, "must-fix");
        assert.equal(section.findings[0].disposition, "accepted-for-fix");
      } else {
        assert.match(marker, /must-fix: 0/);
        assert.match(marker, new RegExp(`worth-fixing-now: ${FINDINGS_PER_ANGLE}`));
        assert.match(marker, /defer: 0/);
        assert.equal(section.findings[0].severity, "worth-fixing-now");
        assert.equal(section.findings[0].disposition, "deferred");
      }
    }

    // Run the REAL upsert-checkpoint-verdict.mjs validation/render functions
    // (not a re-implementation): the marked shape must still normalize,
    // cover a fanout_fanin gate's mandatory angles/pool with no foreign
    // angle, AND actually render without the renderer's own 2000-char
    // structured-block bound rejecting it.
    const normalized = normalizeStructuredFindings(result.findingsJson);
    assert.ok(Array.isArray(normalized), "budget-marked findingsJson must still normalize");
    const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(result.findingsJson, {
      mandatoryAngles: ["pr-description"],
      pool: [...angleNames, "pr-description"],
    });
    assert.deepEqual(missingMandatory, []);
    assert.deepEqual(foreignAngles, []);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Per-angle degradation regression: the verbose-vs-bare choice is decided
// PER ANGLE, not once for the whole round — a round with enough angles that
// NOT ALL of them can afford the verbose breakdown must still give the ones
// that fit the full sentence, rather than dropping to bare everywhere the
// instant any single angle can't afford it (that would leave most of the
// budget unused and the documented breakdown effectively unreachable). Every
// marker is either the WHOLE verbose sentence or the WHOLE bare one — never a
// half-truncated fragment of either. These thresholds are measured against
// the real renderer (see fitsRenderBudget) — retune if the marker/renderer
// text changes.
test("a fan-in with enough angles that not all can afford the verbose marker keeps it on the ones that fit and uses bare only where it doesn't", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 14;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);
    assert.equal(result.findingsJson.length, ANGLE_COUNT); // real angle set preserved

    let verboseCount = 0;
    let bareCount = 0;
    for (const section of result.findingsJson) {
      assert.equal(section.verdict, "findings_present");
      assert.equal(section.findings.length, 1);
      const summary = section.findings[0].summary;
      if (summary === `${FINDINGS_PER_ANGLE} omitted — see ledger`) {
        bareCount += 1;
      } else if (summary.startsWith(`${FINDINGS_PER_ANGLE} finding(s) omitted from this comment`) && summary.endsWith("see the disposition ledger")) {
        verboseCount += 1;
      } else {
        assert.fail(`marker summary is neither the whole verbose sentence nor the whole bare one (half-truncated?): ${summary}`);
      }
      assert.equal(section.findings[0].disposition, "deferred");
    }
    // BOTH forms present — proves the choice is per angle, not per round.
    assert.ok(verboseCount > 0, "expected at least one angle to keep the verbose breakdown");
    assert.ok(bareCount > 0, "expected at least one angle to degrade to bare");

    // The ledger is still complete regardless of how far any marker degraded.
    assert.equal(result.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// All-bare tier regression: enough angles that NONE can afford the verbose
// marker (not even one), so every angle degrades to the bare form — proves
// tier 2 still functions on its own, independent of the per-angle mix above.
test("a fan-in with enough angles that none can afford the verbose marker uses bare everywhere and still renders", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 21;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);
    assert.equal(result.findingsJson.length, ANGLE_COUNT); // real angle set preserved
    for (const section of result.findingsJson) {
      assert.equal(section.verdict, "findings_present");
      assert.equal(section.findings.length, 1);
      // Exactly the bare sentence — never a truncated fragment of the
      // verbose one (no " …", no cut-off mid-word).
      assert.equal(section.findings[0].summary, `${FINDINGS_PER_ANGLE} omitted — see ledger`);
      assert.equal(section.findings[0].disposition, "deferred");
    }
    // The ledger is still complete regardless of how far the marker degraded.
    assert.equal(result.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Budget-allocation-by-severity regression: when not every angle can afford
// the verbose marker, the scarce budget must go to the must-fix-carrying
// angle first, regardless of filename/artifact-index order. All 13 "defer"
// angles sort alphabetically BEFORE the one must-fix-carrying angle
// ("z-mustfix"), so an index/filename-ordered upgrade walk (the prior,
// reverted behavior) would spend the verbose budget on defer-only angles and
// leave the must-fix angle bare. Reverting the severity-first ordering back
// to plain index order fails this test.
test("the must-fix-carrying angle wins the scarce verbose-marker budget over defer-only angles regardless of file/name order", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const DEFER_ANGLE_COUNT = 13;
  const files = {};
  for (let i = 0; i < DEFER_ANGLE_COUNT; i++) {
    files[`d${String(i).padStart(2, "0")}.json`] = {
      angle: `defer-angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "defer",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  files["z-mustfix.json"] = {
    angle: "mustfix-angle",
    verdict: "findings_present",
    findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
      severity: "must-fix",
      summary: `finding mustfix-${j} ${"z".repeat(150)}`,
      file: "src/fmustfix.mjs",
      line: j + 1,
    })),
  };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);

    const byAngle = new Map(result.findingsJson.map((a) => [a.angle, a]));
    const mustFixSummary = byAngle.get("mustfix-angle").findings[0].summary;
    assert.match(
      mustFixSummary,
      new RegExp(`^${FINDINGS_PER_ANGLE} finding\\(s\\) omitted`),
      "the must-fix-carrying angle must keep the verbose breakdown",
    );

    // Sanity: this fixture really does force at least one angle to bare —
    // otherwise the test would pass even with the old, unfixed ordering.
    const bareCount = [...byAngle.values()].filter(
      (a) => a.findings[0].summary === `${FINDINGS_PER_ANGLE} omitted — see ledger`,
    ).length;
    assert.ok(bareCount > 0, "fixture must force at least one angle to bare to actually exercise the allocation choice");
  });
});

// Structural-floor regression: a round with far more real angles than the
// default fan-out cap, wide enough that even ONE bare "N omitted" line per
// angle cannot fit the render budget — no per-angle shape can, no matter how
// short the marker text gets. --out must be withheld (never an ok:true shape
// the real renderer would reject), while the ledger stays complete.
test("a fan-in with far more angles than even bare markers can fit withholds --out instead of emitting an unrenderable shape", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 25;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    const ledgerPath = path.join(dir, "out", "ledger.json");
    const result = await consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);
    assert.deepEqual(result.findingsJson, []);

    // --out is WITHHELD — no file written at all — rather than a shape the
    // real renderer would reject.
    await assert.rejects(() => readFile(outPath, "utf8"), { code: "ENOENT" });

    // The ledger is still written in full regardless.
    const writtenLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(writtenLedger.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
    assert.deepEqual(writtenLedger, result.findings);
  });
});

// Stale-file regression: a withheld round must actively REMOVE a prior
// round's --out, not just skip writing a new one — otherwise a caller that
// unconditionally reads --out (rather than checking "commentBudgetExceeded")
// posts a PRIOR round's findings as though they were current. Reverting the
// fix (skip-write instead of remove) fails this test.
test("a withheld round removes a stale --out left on disk from a prior round", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 25;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    await mkdir(path.dirname(outPath), { recursive: true });
    const staleFromPriorRound = [{ angle: "angle-0", verdict: "clean", findings: [] }];
    await writeFile(outPath, JSON.stringify(staleFromPriorRound), "utf8");

    const result = await consolidateGateFanin({ findingsDir: dir, out: outPath });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findingsJson, []); // withheld tier

    await assert.rejects(() => readFile(outPath, "utf8"), { code: "ENOENT" });
  });
});

// Ledger-durability regression: --ledger-out must land on disk even when the
// --out path itself is unwritable, on BOTH the withheld-tier rm() path and
// the normal mkdir/writeFile path — the ledger is documented as "ALWAYS
// complete (never budgeted)" and must never be reachable only through the
// comment-output path. Reverting to writing --out before --ledger-out fails
// both of these (the throw from --out aborts the function before the ledger
// write runs).
test("a withheld-tier round still writes a complete ledger when --out is an existing directory (rm EISDIR)", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 25;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out-is-a-dir"); // a directory, not a file
    await mkdir(outPath, { recursive: true });
    const ledgerPath = path.join(dir, "ledger.json");

    await assert.rejects(
      () => consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath }),
      { code: "ERR_FS_EISDIR" },
    );

    // The ledger must still be complete on disk despite the --out failure.
    const writtenLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(writtenLedger.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
  });
});

test("a marker-tier round still writes a complete ledger when --out's parent directory is blocked by a regular file (mkdir EEXIST)", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 14;
  const files = {};
  for (let i = 0; i < ANGLE_COUNT; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "worth-fixing-now",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  await withFindingsDir(files, async (dir) => {
    const blockingFile = path.join(dir, "blocking-file");
    await writeFile(blockingFile, "not a directory", "utf8");
    const outPath = path.join(blockingFile, "findings.json"); // parent is a regular file
    const ledgerPath = path.join(dir, "ledger.json");

    await assert.rejects(
      () => consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath }),
      { code: "EEXIST" },
    );

    // The ledger must still be complete on disk despite the --out failure.
    const writtenLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(writtenLedger.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
  });
});
