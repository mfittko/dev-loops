import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consolidateGateFanin,
  fitsRenderBudget,
  parseConsolidateFaninCliArgs,
} from "../../scripts/loop/consolidate-fanin.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { normalizeStructuredFindings, renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { checkFanoutAngleCoverage } from "@dev-loops/core/loop/gate-fanin";
import { buildCacheTelemetryEvidence } from "@dev-loops/core/loop/cache-telemetry-evidence";
import { buildPrimerEvidence } from "@dev-loops/core/loop/primer-evidence";
import { buildReviewDispatchPlan, CACHE_BOUNDARY_AFTER_SHARED_PREFIX, PRIMER_FORM_LEAD_REVIEWER } from "@dev-loops/core/loop/review-dispatch-plan";
import { runNode } from "../_helpers.mjs";

// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.

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

// Shared wide-angle fixture: `angleCount` angles, each carrying
// `findingsPerAngle` findings whose summary is padded well past the
// render-budget shrink floor — used by every test below that needs a round
// large enough to force some degree of budget degradation. The exact
// generated shape (padding length, filename pattern) is calibrated against
// the real renderer (see fitsRenderBudget); retune HERE (once) if the
// marker/renderer text changes, rather than in each call site.
function wideAngleFiles({ angleCount, findingsPerAngle = 30, severity = "worth-fixing-now" }) {
  const files = {};
  for (let i = 0; i < angleCount; i++) {
    files[`angle${i}.json`] = {
      angle: `angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: findingsPerAngle }, (_, j) => ({
        severity,
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  return files;
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

// --out and --ledger-out must never resolve to the same path: the withheld
// tier writes --ledger-out first, then rm()s --out, so an identical path
// would delete the ledger it just wrote while still returning ok:true — a
// success envelope over zero durable evidence, the exact class of failure
// this CLI exists to eliminate. Compared as RESOLVED paths, not raw strings,
// so "./out.json" vs "out.json" is caught too.
test("parseConsolidateFaninCliArgs rejects --out and --ledger-out resolving to the same path (#1513)", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/same.json", "--ledger-out", "/tmp/same.json"]),
    /--out and --ledger-out must not resolve to the same path/,
  );
});

test("parseConsolidateFaninCliArgs rejects --out and --ledger-out that resolve to the same path via different spellings (#1513)", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/dir/../same.json", "--ledger-out", "/tmp/same.json"]),
    /--out and --ledger-out must not resolve to the same path/,
  );
});

test("parseConsolidateFaninCliArgs allows distinct --out/--ledger-out paths", () => {
  assert.doesNotThrow(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/out.json", "--ledger-out", "/tmp/ledger.json"]),
  );
});

// --out/--ledger-out must not resolve to a direct TOP-LEVEL sibling of
// --findings-dir's own artifacts: the withheld tier rm()s --out outright
// (deleting a real artifact if it were aliased in), and a .json write
// directly under --findings-dir would be picked up as a per-angle findings
// artifact by the NEXT consolidation of that same directory.
test("parseConsolidateFaninCliArgs rejects --out resolving to a direct top-level sibling inside --findings-dir", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/x/out.json"]),
    /--out must not resolve to a direct sibling of the artifacts inside --findings-dir/,
  );
});

test("parseConsolidateFaninCliArgs rejects --ledger-out resolving to a direct top-level sibling inside --findings-dir", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--ledger-out", "/tmp/x/ledger.json"]),
    /--ledger-out must not resolve to a direct sibling of the artifacts inside --findings-dir/,
  );
});

// A same-named SIBLING directory ("/tmp/x-2") must not be mistaken for a
// path inside "/tmp/x" — the containment check compares the resolved parent
// directory exactly, not a bare string-prefix match.
test("parseConsolidateFaninCliArgs allows --out in a sibling directory that merely shares --findings-dir's name as a prefix", () => {
  assert.doesNotThrow(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/x-2/out.json"]),
  );
});

// Artifact discovery only reads TOP-LEVEL *.json entries in --findings-dir
// (never recursive), so a path in a SUBdirectory of --findings-dir can never
// be re-read as a per-angle artifact and must stay allowed — this is exactly
// the shape this module's own tests use for --out/--ledger-out.
test("parseConsolidateFaninCliArgs allows --out/--ledger-out in a subdirectory of --findings-dir", () => {
  assert.doesNotThrow(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--out", "/tmp/x/out/findings.json", "--ledger-out", "/tmp/x/out/ledger.json"]),
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
      assert.deepEqual(result.severityCounts, { high: 1, medium: 1, low: 0, question: 0, nit: 0 });
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
          findings: [{ severity: "high", summary: "x", disposition: "accepted-for-fix" }],
        }],
        findings: [{ severity: "high", angle: "scope", summary: "x", disposition: "accepted-for-fix" }],
        severityCounts: { high: 1, medium: 0, low: 0, question: 0, nit: 0 },
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

test("consolidateGateFanin writes --ledger-out as the { overallVerdict, findings } wrapper write-gate-findings-log.mjs/post-gate-findings.mjs accept", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const ledgerPath = path.join(dir, "out", "ledger.json");
      const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: ledgerPath });
      const written = JSON.parse(await readFile(ledgerPath, "utf8"));
      // --ledger-out carries the consolidator's computed overallVerdict
      // alongside the flat findings, so it flows downstream to the durable
      // ledger (and upsert-checkpoint-verdict.mjs's enforcement) without an
      // orchestrator hand-off (#1616).
      assert.deepEqual(written, { overallVerdict: result.overallVerdict, findings: result.findings });
      assert.equal(result.findings.length, 1);
    },
  );
});

// One-shot fan-in (AC4): a SINGLE consolidateGateFanin call with both --out
// and --ledger-out must report verdict, severityCounts, AND both artifact
// paths on its own return value, so a caller never needs a second call just
// to re-extract a different shape or rediscover a path it already passed in.
test("consolidateGateFanin echoes verdict, severityCounts, and both written artifact paths from one call", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const outPath = path.join(dir, "out", "findings.json");
      const ledgerPath = path.join(dir, "out", "ledger.json");
      const result = await consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath });
      assert.equal(result.overallVerdict, "findings_present");
      assert.deepEqual(result.severityCounts, { high: 1, medium: 0, low: 0, question: 0, nit: 0 });
      assert.equal(result.out, outPath);
      assert.equal(result.ledgerOut, ledgerPath);
      // Both echoed paths are real, already-written files — a caller never
      // has to guess or re-derive them from a second invocation.
      assert.ok(JSON.parse(await readFile(outPath, "utf8")));
      assert.ok(JSON.parse(await readFile(ledgerPath, "utf8")));
    },
  );
});

// Same guarantee through the real CLI entrypoint with --jq: the ONE call that
// writes --out/--ledger-out to disk also prints just severityCounts on
// stdout via --jq, proving the shipped procedure (write both artifacts AND
// extract severityCounts) needs no second invocation.
test("consolidate-fanin CLI: one invocation with --out/--ledger-out/--jq writes both artifacts and prints severityCounts", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const cliOutDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-cli-oneshot-"));
      try {
        const outPath = path.join(cliOutDir, "findings.json");
        const ledgerPath = path.join(cliOutDir, "ledger.json");
        const cliResult = await runNode(
          path.join(import.meta.dirname, "..", "..", "scripts", "loop", "consolidate-fanin.mjs"),
          ["--findings-dir", dir, "--out", outPath, "--ledger-out", ledgerPath, "--jq", ".severityCounts"],
        );
        assert.equal(cliResult.code, 0, cliResult.stderr);
        assert.deepEqual(JSON.parse(cliResult.stdout), { high: 1, medium: 0, low: 0, question: 0, nit: 0 });
        assert.ok(JSON.parse(await readFile(outPath, "utf8")));
        assert.ok(JSON.parse(await readFile(ledgerPath, "utf8")));
      } finally {
        await rm(cliOutDir, { recursive: true, force: true });
      }
    },
  );
});

// A tier-4 (withheld) round never writes --out — "out" must be omitted from
// the result rather than pointing at a file that was deleted (or never
// existed), which would send a caller to read stale/missing content.
test("consolidateGateFanin omits \"out\" from the result when the round is withheld (tier 4)", async () => {
  // Same structural-floor fixture the withheld-tier tests below use (25
  // angles x 30 findings each) — far more real angles than even a bare
  // marker per angle can fit.
  const files = wideAngleFiles({ angleCount: 25, findingsPerAngle: 30 });
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    const ledgerPath = path.join(dir, "out", "ledger.json");
    const result = await consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath });
    assert.equal(result.commentBudgetExceeded, true);
    assert.deepEqual(result.findingsJson, []); // withheld tier
    // withheld: no --out file on disk, and the result must not claim one.
    assert.equal("out" in result, false);
    assert.equal(result.ledgerOut, ledgerPath);
    await assert.rejects(() => readFile(outPath, "utf8"), { code: "ENOENT" });
  });
});

// Short errors (AC5): an argument error's stderr JSON is a one-line error +
// hint, never the CLI's own (multi-KB) USAGE text — that full text renders
// only under --help, which is unaffected.
test("consolidate-fanin CLI: an argument error prints a short hint (not the full USAGE text), exit 1", async () => {
  const cliResult = await runNode(
    path.join(import.meta.dirname, "..", "..", "scripts", "loop", "consolidate-fanin.mjs"),
    [],
  );
  assert.equal(cliResult.code, 1);
  assert.equal(cliResult.stdout, "");
  const payload = JSON.parse(cliResult.stderr);
  assert.deepEqual(Object.keys(payload), ["ok", "error", "hint"]);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Missing required argument: --findings-dir/);
  assert.equal(payload.hint, "run with --help for usage");
  assert.equal("usage" in payload, false);
});

test("consolidate-fanin CLI: --help still prints the full USAGE text on stdout, exit 0", async () => {
  const cliResult = await runNode(
    path.join(import.meta.dirname, "..", "..", "scripts", "loop", "consolidate-fanin.mjs"),
    ["--help"],
  );
  assert.equal(cliResult.code, 0);
  assert.equal(cliResult.stderr, "");
  assert.match(cliResult.stdout, /^Usage: consolidate-fanin\.mjs/);
  assert.match(cliResult.stdout, /--findings-dir <dir>/);
});

// parseConsolidateFaninCliArgs's --out/--ledger-out same-path guard is a
// STRING comparison over the CLI's own argv, so it protects only callers that
// go through the parser. consolidateGateFanin is exported and called directly
// (as this test file does throughout), so the shared function needs its own
// identity check right before the destructive --out rm/writeFile — otherwise
// a programmatic caller, or a same-file ALIAS (case-only spelling on a
// case-insensitive filesystem, or a symlink) that the parser's string compare
// cannot catch, still writes the ledger and then destroys it.
test("consolidateGateFanin rejects --out === --ledger-out even when the CLI parser is bypassed", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const samePath = path.join(dir, "out", "same.json");
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, out: samePath, ledgerOut: samePath }),
        /resolve to the same file/,
      );
      // The ledger must still be intact on disk, not deleted by the rm() the
      // guard exists to prevent from ever running against it.
      const written = JSON.parse(await readFile(samePath, "utf8"));
      assert.equal(written.findings.length, 1);
    },
  );
});

test("consolidateGateFanin rejects a --out that is a symlink alias of --ledger-out (same file, different spelling)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] } },
    async (dir) => {
      const ledgerPath = path.join(dir, "out", "ledger.json");
      const outAlias = path.join(dir, "aliases", "out-alias.json");
      await mkdir(path.dirname(ledgerPath), { recursive: true });
      await mkdir(path.dirname(outAlias), { recursive: true });
      await symlink(ledgerPath, outAlias);
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, out: outAlias, ledgerOut: ledgerPath }),
        /resolve to the same file/,
      );
      const written = JSON.parse(await readFile(ledgerPath, "utf8"));
      assert.equal(written.findings.length, 1);
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

// Regression (renderer-security, PR#1513 gate review): unlike summary/
// recommendation, `file` was previously copied through verbatim with no
// length bound — a path reference never legitimately needs anywhere near
// MAX_FINDING_TEXT_LENGTH, and fitFindingsToRenderBudget only shrinks
// summary, so an oversized `file` could not be compressed and would force
// even a short, real finding into the marker/withheld tiers.
test("a finding's oversized file reference is truncated with a plain ellipsis suffix, never left unbounded", async () => {
  const longFile = "f".repeat(400);
  await withFindingsDir(
    {
      "scope.json": {
        angle: "scope",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "short", file: longFile }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      const flat = result.findings[0];
      assert.equal(flat.files[0].length, 300);
      assert.ok(flat.files[0].endsWith(" …"));
      const nested = result.findingsJson.find((a) => a.angle === "scope").findings[0];
      assert.equal(nested.file.length, 300);
      assert.ok(nested.file.endsWith(" …"));
    },
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GATE-EXEC-PRIMER-EVIDENCE wiring (#1475): the fan-in enforces the recorded
// primer-dispatch evidence against the dispatch plan via enforcePrimerEvidence,
// failing closed on missing/mismatched evidence — and proceeds unchanged when
// neither flag is given (progressive/optional recording).
// ---------------------------------------------------------------------------

const PRIMER_FP = "sha256:" + "a".repeat(64);
const PRIMER_HEAD = "0123456789abcdef0123456789abcdef01234567";

function makePrimerPlanAndEvidence() {
  const plan = buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: PRIMER_HEAD,
    sharedPrefixPath: "/tmp/shared.md",
    sharedPrefixHash: PRIMER_FP,
    requestGroups: [
      {
        model: "model-a",
        requestPrefixFingerprint: PRIMER_FP,
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
        ttlIntent: "1h",
        angles: ["scope", "dry"],
      },
    ],
    capabilities: { harness: "claude" },
  });
  const evidence = buildPrimerEvidence({
    plan,
    primerRuns: [{ model: "model-a", requestPrefixFingerprint: PRIMER_FP, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
    reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: PRIMER_FP, releasedAt: 11 }],
  });
  return { plan, evidence };
}

async function withPrimerFiles(files, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "primer-evidence-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("consolidateGateFanin enforces valid primer evidence and consolidates (GATE-EXEC-PRIMER-EVIDENCE)", async () => {
  const { plan, evidence } = makePrimerPlanAndEvidence();
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await withPrimerFiles(
        { "primer-evidence.json": evidence, "primer-plan.json": plan },
        async (pdir) => {
          const result = await consolidateGateFanin({
            findingsDir: dir,
            primerEvidence: path.join(pdir, "primer-evidence.json"),
            primerPlan: path.join(pdir, "primer-plan.json"),
          });
          assert.equal(result.ok, true);
          assert.equal(result.overallVerdict, "clean");
          assert.equal(result.angles.length, 1);
        },
      );
    },
  );
});

test("consolidateGateFanin fails closed when primer evidence violates the ordering barrier", async () => {
  const { plan } = makePrimerPlanAndEvidence();
  // Violation: the reviewer release at t=5 lands BEFORE its primer at t=10.
  const violation = buildPrimerEvidence({
    plan,
    primerRuns: [{ model: "model-a", requestPrefixFingerprint: PRIMER_FP, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
    reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: PRIMER_FP, releasedAt: 5 }],
  });
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await withPrimerFiles(
        { "primer-evidence.json": violation, "primer-plan.json": plan },
        async (pdir) => {
          await assert.rejects(
            consolidateGateFanin({
              findingsDir: dir,
              primerEvidence: path.join(pdir, "primer-evidence.json"),
              primerPlan: path.join(pdir, "primer-plan.json"),
            }),
            (err) => err.message.includes("GATE-EXEC-PRIMER-EVIDENCE") && err.message.includes("primer_order"),
          );
        },
      );
    },
  );
});

test("consolidateGateFanin fails closed when primer evidence references a plan it did not come from", async () => {
  const { evidence } = makePrimerPlanAndEvidence();
  // A DIFFERENT plan (different request group model) than the evidence was
  // built from: the plan-hash / shared-prefix bindings no longer match.
  const otherPlan = buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: PRIMER_HEAD,
    sharedPrefixPath: "/tmp/shared.md",
    requestGroups: [
      {
        model: "model-c",
        requestPrefixFingerprint: "sha256:" + "c".repeat(64),
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
        ttlIntent: "1h",
        angles: ["scope"],
      },
    ],
    capabilities: { harness: "claude" },
  });
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await withPrimerFiles(
        { "primer-evidence.json": evidence, "primer-plan.json": otherPlan },
        async (pdir) => {
          await assert.rejects(
            consolidateGateFanin({
              findingsDir: dir,
              primerEvidence: path.join(pdir, "primer-evidence.json"),
              primerPlan: path.join(pdir, "primer-plan.json"),
            }),
            (err) => err.message.includes("GATE-EXEC-PRIMER-EVIDENCE") && err.message.includes("shared_prefix_hash"),
          );
        },
      );
    },
  );
});

test("parseConsolidateFaninCliArgs rejects --primer-evidence without --primer-plan (and vice versa)", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--primer-evidence", "/tmp/e.json"]),
    /--primer-evidence and --primer-plan must be given together/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--primer-plan", "/tmp/p.json"]),
    /--primer-evidence and --primer-plan must be given together/,
  );
});

// --------------------------------------------------------------------------
// GATE-EXEC-CACHE-TELEMETRY wiring (#1476): the fan-in enforces the before/after
// cache-telemetry evidence via enforceCacheTelemetryEvidence, failing closed on
// an opaque/over-claimed/unmeasured artifact — and proceeds unchanged when the
// flag is absent (progressive/optional recording).
// --------------------------------------------------------------------------

const TELEMETRY_HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function makeTelemetryPlan() {
  return buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: TELEMETRY_HEAD,
    sharedPrefixHash: PRIMER_FP,
    requestGroups: [
      {
        model: "model-a",
        requestPrefixFingerprint: PRIMER_FP,
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
        ttlIntent: "1h",
        angles: ["scope"],
      },
    ],
    capabilities: { harness: "claude" },
  });
}

function makeTelemetryEvidence() {
  return buildCacheTelemetryEvidence({
    plan: makeTelemetryPlan(),
    primerCacheCreations: [{ model: "model-a", primerForm: "lead_reviewer", tokens: 12000 }],
    reviewerCacheReads: [
      { model: "model-a", angle: "scope", tokens: 200 },
      { model: "model-a", angle: "dry", tokens: 210 },
    ],
  });
}

async function withTelemetryFile(filename, content, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cache-telemetry-"));
  try {
    await writeFile(path.join(dir, filename), typeof content === "string" ? content : JSON.stringify(content), "utf8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("consolidateGateFanin enforces valid cache-telemetry evidence (GATE-EXEC-CACHE-TELEMETRY)", async () => {
  const evidence = makeTelemetryEvidence();
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: TELEMETRY_HEAD } },
    async (dir) => {
      await withTelemetryFile("cache-telemetry.json", evidence, async (tdir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          cacheTelemetry: path.join(tdir, "cache-telemetry.json"),
          headSha: TELEMETRY_HEAD,
          gate: "pre_approval_gate",
        });
        assert.equal(result.ok, true);
      });
    },
  );
});

test("consolidateGateFanin fails closed on a cache-telemetry artifact stamped for a different head/gate", async () => {
  // The artifact is <gate>-<headSha>-scoped evidence: a stale/mismatched
  // artifact for a different head OR gate must fail closed rather than pass as
  // this round's telemetry when --head-sha/--gate are provided.
  const evidence = makeTelemetryEvidence(); // stamped for TELEMETRY_HEAD / pre_approval_gate
  const wrongHead = { ...evidence, headSha: "ffffffffffffffffffffffffffffffffffffffff" };
  const wrongGate = { ...evidence, gate: "draft_gate" };
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: TELEMETRY_HEAD } },
    async (dir) => {
      await withTelemetryFile("cache-telemetry.json", wrongHead, async (tdir) => {
        await assert.rejects(
          consolidateGateFanin({
            findingsDir: dir,
            cacheTelemetry: path.join(tdir, "cache-telemetry.json"),
            headSha: TELEMETRY_HEAD,
            gate: "pre_approval_gate",
          }),
          (err) => err.message.includes("stale/mismatched cache-telemetry artifact"),
        );
      });
      await withTelemetryFile("cache-telemetry.json", wrongGate, async (tdir) => {
        await assert.rejects(
          consolidateGateFanin({
            findingsDir: dir,
            cacheTelemetry: path.join(tdir, "cache-telemetry.json"),
            headSha: TELEMETRY_HEAD,
            gate: "pre_approval_gate",
          }),
          (err) => err.message.includes("mismatched cache-telemetry artifact"),
        );
      });
    },
  );
});

test("consolidateGateFanin fails closed on cache telemetry over-claiming opaque reuse", async () => {
  // Build under an opaque (pi) harness then mutate the verdict to simulate an
  // over-claim; the fan-in must refuse it as an opaque_veracity violation.
  const plan = buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: TELEMETRY_HEAD,
    requestGroups: [
      {
        model: "model-a",
        requestPrefixFingerprint: PRIMER_FP,
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
        ttlIntent: "1h",
        angles: ["scope"],
      },
    ],
    capabilities: { harness: "pi" },
  });
  const honest = buildCacheTelemetryEvidence({
    plan,
    primerCacheCreations: [{ model: "model-a" }],
    reviewerCacheReads: [{ model: "model-a", angle: "scope" }],
  });
  const subverted = { ...honest, cacheReuseVerified: true };
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await withTelemetryFile("cache-telemetry.json", subverted, async (tdir) => {
        await assert.rejects(
          consolidateGateFanin({
            findingsDir: dir,
            cacheTelemetry: path.join(tdir, "cache-telemetry.json"),
          }),
          (err) => err.message.includes("GATE-EXEC-CACHE-TELEMETRY") && err.message.includes("opaque_veracity"),
        );
      });
    },
  );
});

test("consolidateGateFanin fails closed on an unreadable/malformed cache-telemetry artifact", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await withTelemetryFile("cache-telemetry.json", "{ not json", async (tdir) => {
        await assert.rejects(
          consolidateGateFanin({
            findingsDir: dir,
            cacheTelemetry: path.join(tdir, "cache-telemetry.json"),
          }),
          (err) => err.message.includes("not valid JSON"),
        );
      });
    },
  );
});

test("consolidateGateFanin fails closed on a missing (unreadable) cache-telemetry path", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await assert.rejects(
        consolidateGateFanin({
          findingsDir: dir,
          cacheTelemetry: "/nonexistent/cache-telemetry.json",
        }),
        (err) => err.message.includes("could not be read"),
      );
    },
  );
});

test("consolidateGateFanin proceeds unchanged without a cache-telemetry artifact", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.equal(result.ok, true);
    },
  );
});

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
// --carried-angles upsert: a carry-forward plan's `carried` angles got no
// Phase 2 artifact and would otherwise be invisible to findingsJson/
// checkFanoutAngleCoverage/the posted verdict comment — indistinguishable
// from a truncated fan-out.
//
// must-fix (gate-evidence): --carried-angles is proof-carrying, not a bare
// trust-me list — it REQUIRES --gate and --carry-forward-plan
// (resolve-angle-carry-forward.mjs's own "carried" evidence) and is checked
// against BOTH the gate's configured mandatory angles and the proven plan
// before it is allowed to mint a clean entry. See the fail-closed tests below.
// ---------------------------------------------------------------------------

// Isolated repoRoot with a minimal .devloops: this repo's shipped
// extension-defaults.yaml always contributes the draft gate's own mandatory
// angle ("pr-description") regardless of repoRoot (D3 name-merge across
// config layers), so an empty/minimal override here is enough to get a real,
// known mandatoryAngles set without hand-writing angle entries.
async function withMinimalConfigRepoRoot(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-cfgroot-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "version: 1\n", "utf8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function carryForwardPlanJson(angles, { carriedFromHead = "a".repeat(40) } = {}) {
  return JSON.stringify({ carried: angles.map((angle) => ({ angle, carriedFromHead, reason: "test fixture" })) });
}

test("parseConsolidateFaninCliArgs parses --carried-angles + --carry-forward-plan together", () => {
  const result = parseConsolidateFaninCliArgs([
    "--findings-dir", "/tmp/x",
    "--gate", "draft_gate",
    "--carried-angles", '["correctness","docs"]',
    "--carry-forward-plan", carryForwardPlanJson(["correctness", "docs"]),
  ]);
  assert.deepEqual(result.carriedAngles, ["correctness", "docs"]);
  assert.deepEqual(result.carryForwardPlan.map((e) => e.angle), ["correctness", "docs"]);
});

test("parseConsolidateFaninCliArgs rejects unparseable/non-array/empty-string --carried-angles", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carried-angles", "not json"]),
    /--carried-angles must be a JSON array/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carried-angles", '{"angle":"docs"}']),
    /--carried-angles must be a JSON array of non-empty angle-name strings/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carried-angles", '["docs",""]']),
    /--carried-angles must be a JSON array of non-empty angle-name strings/,
  );
});

test("parseConsolidateFaninCliArgs rejects a malformed --carry-forward-plan", () => {
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", "not json"]),
    /--carry-forward-plan must be JSON/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", '["docs"]']),
    /carried\[0\] must be an object with non-empty string "angle" and "carriedFromHead"/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", '"not-an-object-or-array"']),
    /--carry-forward-plan must be a JSON object with a "carried" array, or a bare JSON array/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", '{"notCarried":[]}']),
    /--carry-forward-plan must have a "carried" array/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", '{"carried":[{"angle":"docs"}]}']),
    /carried\[0\] must be an object with non-empty string "angle" and "carriedFromHead"/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carry-forward-plan", '{"carried":[{"angle":"docs","carriedFromHead":"not-a-sha"}]}']),
    /carried\[0\]\.carriedFromHead must be a 7-64 char hex SHA/,
  );
});

// contract-surface (worth-fixing-now): the shipped Phase 3 procedure, this
// CLI's own --help, and its former error text all documented --carry-forward-plan
// as accepting "resolve-angle-carry-forward.mjs's own result, or at least its
// `carried` array" — but the parser rejected a bare array outright. Accept it
// (normalized to `{ carried: <array> }`) so that documented shorthand is true,
// rather than rewriting four doc/error-text sites to instead demand the
// wrapper object.
test("parseConsolidateFaninCliArgs accepts a bare JSON array as --carry-forward-plan", () => {
  const result = parseConsolidateFaninCliArgs([
    "--findings-dir", "/tmp/x",
    "--gate", "draft_gate",
    "--carried-angles", '["docs"]',
    "--carry-forward-plan", '[{"angle":"docs","carriedFromHead":"AAA1234"}]',
  ]);
  assert.deepEqual(result.carryForwardPlan, [{ angle: "docs", carriedFromHead: "aaa1234" }]);
});

test("parseConsolidateFaninCliArgs rejects --carried-angles / --carry-forward-plan / --gate given without each other", () => {
  const plan = carryForwardPlanJson(["docs"]);
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--gate", "draft_gate", "--carried-angles", '["docs"]']),
    /--carried-angles requires --carry-forward-plan/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--gate", "draft_gate", "--carry-forward-plan", plan]),
    /--carry-forward-plan was given without --carried-angles/,
  );
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--carried-angles", '["docs"]', "--carry-forward-plan", plan]),
    /--carried-angles requires --gate/,
  );
});

test("consolidateGateFanin upserts a carriedFromHead-marked clean entry for every carried angle with no real artifact", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "docs.json": { angle: "docs", verdict: "clean", findings: [] } },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["correctness", "coverage"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["correctness", "coverage"], { carriedFromHead: "b".repeat(40) })).carried,
        });
        assert.deepEqual(
          result.angles.map((a) => a.angle).sort(),
          ["correctness", "coverage", "docs"],
        );
        // Carried entries are marked; the freshly reviewed "docs" entry is not.
        assert.deepEqual(
          result.findingsJson.find((a) => a.angle === "correctness"),
          { angle: "correctness", verdict: "clean", findings: [], carriedFromHead: "b".repeat(40) },
        );
        assert.equal(result.angles.find((a) => a.angle === "correctness").carriedFromHead, "b".repeat(40));
        assert.equal(result.angles.find((a) => a.angle === "docs").carriedFromHead, undefined);
        assert.equal(result.overallVerdict, "clean");
      },
    );
  });
});

test("consolidateGateFanin never overrides a REAL artifact with a --carried-angles upsert for the same angle", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      {
        "correctness.json": {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "real finding, not carried" }],
        },
      },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["correctness"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["correctness"])).carried,
        });
        assert.equal(result.angles.length, 1);
        assert.equal(result.angles[0].findingCount, 1, "the real artifact's finding must survive, not be replaced by the synthetic clean upsert");
        assert.equal(result.angles[0].carriedFromHead, undefined, "a REAL artifact's entry is never marked carried");
      },
    );
  });
});

// A real artifact whose angle collides with a carried name only by case or by
// a `-delta-at-...` suffix must still suppress the synthetic upsert (base-name
// + case-insensitive match, same rule resolve-angle-carry-forward.mjs's own
// attribution uses) — an exact-string check would duplicate the angle.
test("consolidateGateFanin suppresses the carried upsert for a case-drifted/delta-suffixed real artifact", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      {
        "coverage.json": {
          angle: "Coverage-delta-at-abc123",
          verdict: "findings_present",
          findings: [{ severity: "worth-fixing-now", summary: "real, case/delta-drifted" }],
        },
      },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["coverage"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["coverage"])).carried,
        });
        assert.equal(result.angles.length, 1, "the real (case/delta-drifted) artifact must not get a duplicate synthetic clean row");
        assert.equal(result.angles[0].angle, "Coverage-delta-at-abc123");
        assert.equal(result.angles[0].findingCount, 1);
      },
    );
  });
});

// must-fix (gate-evidence, consolidate-fanin.mjs:641): a gate's configured
// MANDATORY angle can never legitimately appear in a carry-forward plan
// (resolve-angle-carry-forward.mjs always forces it into mustRerun), so
// naming one in --carried-angles can only be a fabricated or stale list —
// refuse it even when a (necessarily fabricated) plan entry claims it.
test("consolidateGateFanin refuses a --carried-angles entry that is the gate's configured MANDATORY angle", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["pr-description"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["pr-description"])).carried,
          }),
          /MANDATORY angles.*pr-description|pr-description.*MANDATORY/s,
        );
      },
    );
  });
});

// must-fix (gate-evidence/correctness, round 2): the ALWAYS_INCLUDE surface
// (gate-evidence, renderer-security, pr-description) is refused UNCONDITIONALLY
// — angleReviewSurface returns { kind: "always" } for these regardless of the
// gate's CONFIGURED mandatoryAngles set, so checking only mandatoryAngles (as a
// prior version did) let a plan naming gate-evidence/renderer-security mint a
// clean entry at draft_gate, where neither is configured mandatory.
test("consolidateGateFanin refuses gate-evidence and renderer-security for draft_gate even though neither is a configured mandatory angle there", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    for (const angle of ["gate-evidence", "renderer-security"]) {
      await withFindingsDir(
        { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
        async (dir) => {
          await assert.rejects(
            () => consolidateGateFanin({
              findingsDir: dir,
              gate: "draft_gate",
              repoRoot,
              carriedAngles: [angle],
              carryForwardPlan: JSON.parse(carryForwardPlanJson([angle])).carried,
            }),
            new RegExp(`${angle}.*never legitimately carry forward|can never legitimately carry forward.*${angle}`, "s"),
          );
        },
      );
    }
  });
});

// Same predicate, at pre_approval_gate: pr-description is not in THIS repo's
// configured preApproval mandatoryAngles (acceptance-criteria/yagni/
// contradiction-lens/pr-checklist-matrix are), but it is still hardcoded
// ALWAYS_INCLUDE and must still be refused.
test("consolidateGateFanin refuses pr-description for pre_approval_gate even though it is not that gate's configured mandatory angle", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "pre_approval_gate",
            repoRoot,
            carriedAngles: ["pr-description"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["pr-description"])).carried,
          }),
          /pr-description.*never legitimately carry forward|can never legitimately carry forward.*pr-description/s,
        );
      },
    );
  });
});

// must-fix (gate-evidence, round 3): a MANDATORY angle configured with case
// drift (e.g. "Correctness") must be refused exactly like its lowercase form —
// the compared key is base+lowercase, so the configured mandatory set is
// lowercased before feeding angleReviewSurface's alwaysRerun.
test("consolidateGateFanin refuses a case-drifted configured mandatory angle from a carry plan", async () => {
  const dir0 = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-cfgroot-"));
  try {
    await writeFile(
      path.join(dir0, ".devloops"),
      "version: 1\ngates:\n  draft:\n    angles:\n      - name: Correctness\n        mandatory: true\n",
      "utf8",
    );
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot: dir0,
            carriedAngles: ["correctness"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["correctness"])).carried,
          }),
          /correctness.*never legitimately carry forward|can never legitimately carry forward.*correctness/si,
        );
      },
    );
  } finally {
    await rm(dir0, { recursive: true, force: true });
  }
});

// Copilot round (exact-name plan proof): a carried sibling sharing the base
// key (coverage-delta-at-<sha>) must NOT vouch for a name the plan never
// carried — the presence proof is exact-name, not base-collapsed.
test("consolidateGateFanin refuses a carried angle whose only plan sibling shares the base key", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["coverage"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["coverage-delta-at-abc1234"])).carried,
          }),
          /coverage.*not present in --carry-forward-plan/s,
        );
      },
    );
  });
});

// An unmapped/unknown angle name (angleReviewSurface -> { kind: "unknown" })
// must also be refused — resolve-angle-carry-forward.mjs's own producer never
// carries such a name either (fail-closed default), so a plan claiming
// otherwise can only be fabricated.
test("consolidateGateFanin refuses an unmapped/unknown --carried-angles entry", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["totally-bogus-unmapped-angle"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["totally-bogus-unmapped-angle"])).carried,
          }),
          /totally-bogus-unmapped-angle.*no declared review surface|no declared review surface.*totally-bogus-unmapped-angle/s,
        );
      },
    );
  });
});

// must-fix (gate-evidence, consolidate-fanin.mjs:641): a carried name absent
// from the proven carry-forward plan is refused — the plan is the evidence
// that an angle was actually resolved as carried, not just typed in.
test("consolidateGateFanin refuses a --carried-angles entry absent from --carry-forward-plan's carried list", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["correctness"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["coverage"])).carried, // plan proves "coverage", not "correctness"
          }),
          /not present in --carry-forward-plan/,
        );
      },
    );
  });
});

test("consolidateGateFanin fails closed when --carried-angles is given without --gate or --carry-forward-plan (parser bypassed)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, carriedAngles: ["correctness"] }),
        /--carried-angles requires --gate/,
      );
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, gate: "draft_gate", carriedAngles: ["correctness"] }),
        /--carried-angles requires --carry-forward-plan/,
      );
    },
  );
});

// coverage (consolidate-fanin.mjs:587): an all-angles-carried round — Phase 2
// dispatched nothing because Phase 1.2 carried every resolved angle — has a
// legitimately empty --findings-dir; it must consolidate the carried entries
// instead of throwing "contains no *.json findings artifacts".
test("consolidateGateFanin consolidates an all-carried round even with an empty --findings-dir", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-allcarried-"));
    try {
      const result = await consolidateGateFanin({
        findingsDir: emptyDir,
        gate: "draft_gate",
        repoRoot,
        carriedAngles: ["correctness", "coverage"],
        carryForwardPlan: JSON.parse(carryForwardPlanJson(["correctness", "coverage"])).carried,
      });
      assert.deepEqual(result.angles.map((a) => a.angle).sort(), ["coverage", "correctness"].sort());
      assert.equal(result.overallVerdict, "clean");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// determinism (worth-fixing-now): two DISTINCT carried names sharing a
// base+lowercase key (a base angle and its `-delta-at-<sha>` re-review
// sibling — both legal, independently carry-forward-eligible rows per
// resolve-angle-carry-forward.mjs's own bucketed attribution) must BOTH
// upsert, regardless of --carried-angles array order. A prior version's
// upsert-suppression set was mutated inside the loop and collapsed the
// second-listed name into a no-op.
test("consolidateGateFanin upserts both carried entries when two distinct names share a base+lowercase key, in either array order", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    for (const angles of [["coverage", "coverage-delta-at-abc1234"], ["coverage-delta-at-abc1234", "coverage"]]) {
      await withFindingsDir(
        { "docs.json": { angle: "docs", verdict: "clean", findings: [] } },
        async (dir) => {
          const result = await consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: angles,
            carryForwardPlan: JSON.parse(carryForwardPlanJson(angles)).carried,
          });
          assert.deepEqual(
            result.angles.map((a) => a.angle).sort(),
            ["coverage", "coverage-delta-at-abc1234", "docs"].sort(),
            `order ${JSON.stringify(angles)} must not drop either carried sibling`,
          );
        },
      );
    }
  });
});

// coverage (worth-fixing-now): the entry-shape check must be enforced INSIDE
// consolidateGateFanin too, not only on the parse path — a programmatic caller
// bypasses parseConsolidateFaninCliArgs (and its validateCarryForwardPlanShape
// call) entirely. Three previously-untested shapes: missing carriedFromHead
// (the SILENT defect — minted an unmarked clean row indistinguishable from a
// fresh review instead of failing closed), missing angle, and a null entry.
test("consolidateGateFanin fails closed on a malformed programmatic --carry-forward-plan entry (parser bypassed)", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      { "docs.json": { angle: "docs", verdict: "clean", findings: [] } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["correctness"],
            carryForwardPlan: [{ angle: "correctness" }], // missing carriedFromHead
          }),
          /carried\[0\] must be an object with non-empty string "angle" and "carriedFromHead"/,
        );
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["correctness"],
            carryForwardPlan: [{ carriedFromHead: "a".repeat(40) }], // missing angle
          }),
          /carried\[0\] must be an object with non-empty string "angle" and "carriedFromHead"/,
        );
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["correctness"],
            carryForwardPlan: [null],
          }),
          /carried\[0\] must be an object with non-empty string "angle" and "carriedFromHead"/,
        );
      },
    );
  });
});

test("e2e: a legitimately carried, non-mandatory angle fills a gate's pool coverage check alongside a real artifact", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      {
        "scope.json": { angle: "scope", verdict: "clean", findings: [] },
        "pr-description.json": { angle: "pr-description", verdict: "clean", findings: [] },
      },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["dry"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["dry"])).carried,
        });
        const coverage = checkFanoutAngleCoverage(result.findingsJson, {
          mandatoryAngles: ["pr-description"],
          pool: ["scope", "dry", "pr-description"],
        });
        assert.deepEqual(coverage, { missingMandatory: [], foreignAngles: [] });
      },
    );
  });
});

// ---------------------------------------------------------------------------
// defer -> deferred disposition derivation
// ---------------------------------------------------------------------------

test("consolidateGateFanin derives a deferred disposition for nice-to-have findings", async () => {
  await withFindingsDir(
    {
      "naming.json": {
        angle: "naming",
        verdict: "findings_present",
        findings: [{ severity: "nice-to-have", summary: "style nit" }],
      },
    },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, "low"); // "nice-to-have" input normalizes to canonical "low"
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
    assert.equal(result.severityCounts.high, 1); // "must-fix" input normalizes to canonical "high"
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

// must-fix (input-validation): a raw per-angle findings artifact that
// self-declares "carriedFromHead" must NOT flow that claim through — a fresh
// reviewer artifact is the least-trusted input in the flow (subagent-written,
// glob-discovered from --findings-dir) and, before this guard, this bypassed
// BOTH proof checks (--carried-angles's mandatory/ALWAYS_INCLUDE + plan checks)
// entirely: exit 0, angle marked carried, with NO --carried-angles given at
// all. Reproduces the reviewer's exact repro (a mandatory-angle artifact
// self-declaring carriedFromHead, no carry flags whatsoever).
test("consolidateGateFanin refuses a raw artifact that self-declares carriedFromHead, even with no --carried-angles at all", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      {
        "acceptance-criteria.json": {
          angle: "acceptance-criteria",
          verdict: "clean",
          findings: [],
          carriedFromHead: "abc1234",
        },
      },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, gate: "pre_approval_gate", repoRoot }),
          /must not declare "carriedFromHead"/,
        );
      },
    );
  });
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
    // #1592: incidental whitespace around a RECOGNIZED severity is no longer
    // invalid (normalizeSeverity trims — but does NOT lowercase — before the
    // alias lookup; see gate-fanin.test.mjs's own
    // normalizeSeverity("HIGH") === "HIGH" pin, and the sibling "a severity
    // with incidental whitespace..." test in gate-fanin.test.mjs), and an
    // unrecognized severity token is now caught earlier, by this CLI's OWN
    // artifact-shape floor (a distinct,
    // unwrapped Error — not routed through consolidateFanin's "fan-in is
    // blocked" wrapper), which is exactly what a stricter shared floor should
    // do. This variant instead exercises a malformation the floor does NOT
    // check but consolidateFanin's OWN validation does — a mismatched
    // verdict/findings-count pair — so this test still pins two DISTINCT
    // "fan-in is blocked" detail messages.
    "findings-present-with-no-findings": {
      artifact: { angle: "scope", verdict: "findings_present", findings: [] },
      detailPattern: /scope: angle 'scope' reported findings_present but has no findings/,
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

// fitsRenderBudget must classify "over budget" ONLY by the length-exceeded
// throw (enforcePostedCommentLimit's "... exceeds N chars ..."); a shape
// error from normalizeStructuredFindings (producer drift: unrecognized
// items, mixed nested+flat) is a different failure class entirely and must
// propagate, not be silently reported as an over-budget round — which would
// otherwise degrade a malformed-input defect to a withheld/marker-collapsed
// round that still exits 0 (see buildBudgetMarkedFindingsJson's tier-4
// (withheld) --out deletion).
test("fitsRenderBudget rethrows a non-length-bound error instead of misreporting it as over budget", () => {
  const shapeInvalid = [
    { angle: "correctness", verdict: "findings_present", findings: [] },
    { severity: "must-fix", summary: "a flat finding mixed into a per-angle array" },
  ];
  assert.throws(() => fitsRenderBudget(shapeInvalid), /mixes per-angle entries/);
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
    // This is the SHRINK-AND-FIT tier (summaries evenly shrunk, never marked):
    // the round fits after shrinking, so it must be indistinguishable from an
    // under-budget round — no "commentBudgetExceeded" flag, and every angle
    // keeps its real (truncated) summary text rather than an "omitted ... see
    // ledger" marker. A regression that bypasses the shrink loop and degrades
    // straight to markers would also render without throwing, so those two
    // properties (not "does not throw") are what actually pin this tier.
    assert.equal(result.commentBudgetExceeded, undefined);
    for (const [i, section] of result.findingsJson.entries()) {
      const summary = section.findings[0].summary;
      assert.ok(summary.startsWith(`finding ${i}: `), `angle-${i} must keep its real summary text, got: ${summary}`);
      assert.ok(!/omitted.*see (the disposition )?ledger/.test(summary), `angle-${i} must not be marker-collapsed, got: ${summary}`);
    }
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
// block is over 2000 chars (per-finding decoration — severity/file/line/
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
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
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

// A comfortably under-budget round (well under half the render bound) must
// stay raw/unmarked (commentBudgetExceeded absent) and render as-is.
test("a comfortably under-budget round stays raw/unmarked and renders", async () => {
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

// Near-boundary UNDER-budget companion to the false-negative fixture above: 31
// of the SAME shape (must-fix, 3-char summary, "src/a.mjs", 3-digit line)
// renders at 1954 chars — just 46 chars of headroom, since one more (32)
// is exactly what tips it to 2016 and throws (measured against the real
// renderer; see fitsRenderBudget). A round that really does fit this close to
// the bound must still stay raw/unmarked (commentBudgetExceeded absent) and
// render as-is — unconditionally, not only "if the marker path wasn't taken"
// — so a reversion that starts marking everything, or an over-conservative
// estimate, fails this half of the pair.
test("a near-boundary under-budget round (one finding short of the false-negative fixture's throw) stays raw/unmarked and renders", async () => {
  const FINDINGS_PER_ANGLE = 31;
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
    assert.equal(result.commentBudgetExceeded, undefined);
    assert.equal(result.findingsJson[0].findings.length, FINDINGS_PER_ANGLE);
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
      findings[2] = { ...findings[2], severity: "nice-to-have" };
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
    // Legacy-spelled input ("worth-fixing-now"/"must-fix"/"nice-to-have")
    // normalizes to the canonical output vocabulary.
    assert.deepEqual(result.severityCounts, { high: 1, medium: totalFindings - 2, low: 1, question: 0, nit: 0 });
    const writtenLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(writtenLedger, { overallVerdict: result.overallVerdict, findings: result.findings });
    assert.equal(writtenLedger.findings.length, totalFindings);
    const pinnedLedgerEntry = writtenLedger.findings.find((f) => f.summary === PINNED_SUMMARY);
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
      assert.match(marker, /— in the disposition ledger/);
      if (angle === MIXED_ANGLE) {
        // Highest-severity-wins: high beats medium/low, and
        // the marker's own disposition matches that severity's derivation
        // (accepted-for-fix — the default blockCleanOnFindingSeverities is
        // ["high"]). Legacy-spelled input ("must-fix"/"worth-fixing-now"/
        // "nice-to-have") normalizes to the canonical output vocabulary.
        assert.match(marker, /high: 1/);
        assert.match(marker, /medium: 28/);
        assert.match(marker, /low: 1/);
        assert.equal(section.findings[0].severity, "high");
        assert.equal(section.findings[0].disposition, "accepted-for-fix");
      } else {
        assert.match(marker, /high: 0/);
        assert.match(marker, new RegExp(`medium: ${FINDINGS_PER_ANGLE}`));
        assert.match(marker, /low: 0/);
        assert.equal(section.findings[0].severity, "medium");
        assert.equal(section.findings[0].disposition, "deferred");
      }
    }

    // result.angles is the compact per-angle envelope surfaced on stdout
    // (never marker-collapsed) — it must keep reporting each angle's REAL
    // pre-marking findingCount even though --out/--ledger-out's own
    // findingsJson has collapsed every angle to one marker finding. A
    // regression that derived `angles` from the marked findingsJson instead
    // of the raw pre-marking artifacts would silently report findingCount: 1
    // for every angle here.
    const anglesByName = new Map(result.angles.map((a) => [a.angle, a]));
    assert.deepEqual(anglesByName.get("pr-description"), { angle: "pr-description", verdict: "clean", findingCount: 0 });
    for (const angle of angleNames) {
      assert.deepEqual(
        anglesByName.get(angle),
        { angle, verdict: "findings_present", findingCount: FINDINGS_PER_ANGLE },
      );
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

    // The test name and this PR's AC both claim "exits 0" — pin that as an
    // actual CLI exit code and stdout envelope, not just result.ok inferred
    // in-process (the in-process consolidateGateFanin() call above never
    // exercises main()/emitResult()). Reruns the SAME on-disk fixture through
    // the real CLI entrypoint; --out/--ledger-out land OUTSIDE --findings-dir
    // (a sibling temp dir), since neither may resolve inside it.
    const cliOutDir = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-cli-out-"));
    try {
      const cliResult = await runNode(
        path.join(import.meta.dirname, "..", "..", "scripts", "loop", "consolidate-fanin.mjs"),
        ["--findings-dir", dir, "--out", path.join(cliOutDir, "findings.json"), "--ledger-out", path.join(cliOutDir, "ledger.json")],
      );
      assert.equal(cliResult.code, 0, cliResult.stderr);
      const cliPayload = JSON.parse(cliResult.stdout);
      assert.equal(cliPayload.ok, true);
      assert.equal(cliPayload.commentBudgetExceeded, true);
    } finally {
      await rm(cliOutDir, { recursive: true, force: true });
    }
  });
});

// Real-findings-preferred-over-marker regression: an angle with real findings
// that ALREADY fit alongside the rest of the (marked) round must keep them
// as-is, never a marker — a marker is a compression and must never replace
// real content with something rendered BIGGER. Reproduces the reported case:
// a single must-fix finding (file+line) renders far smaller than the verbose
// marker that would otherwise replace it (134 vs 183 chars), while a sibling
// "style" angle with 300 defer findings is what actually forces the round
// over budget and must itself still degrade to a marker.
test("a narrow angle keeps its real finding instead of a longer marker when a wide sibling angle forces the round over budget", async () => {
  const files = {
    "correctness.json": {
      angle: "correctness",
      verdict: "findings_present",
      findings: [{ severity: "must-fix", summary: "null deref at foo.mjs:12 when x is undefined", file: "foo.mjs", line: 12 }],
    },
    "style.json": {
      angle: "style",
      verdict: "findings_present",
      findings: Array.from({ length: 300 }, (_, j) => ({
        severity: "nice-to-have",
        summary: `naming nit ${j} ${"z".repeat(150)}`,
        file: `src/f${j}.mjs`,
        line: j + 1,
      })),
    },
  };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true); // the wide "style" angle alone forces this

    const byAngle = new Map(result.findingsJson.map((a) => [a.angle, a]));
    // "correctness" keeps its REAL finding (severity + file + line), not a marker.
    const correctnessFinding = byAngle.get("correctness").findings[0];
    assert.equal(correctnessFinding.severity, "high"); // "must-fix" input normalizes to canonical "high"
    assert.equal(correctnessFinding.file, "foo.mjs");
    assert.equal(correctnessFinding.line, 12);
    // Full, UN-shrunk text — not just a startsWith prefix, which a
    // whole-round-shrunk-to-the-31-char-floor stub would also satisfy (both
    // start with the same first 25 chars). The pre-shrink snapshot must be
    // offered as the tier-1 (real) candidate first, not the already-crushed array
    // fitFindingsToRenderBudget mutated in place while chasing the whole
    // round's budget.
    assert.equal(correctnessFinding.summary, "null deref at foo.mjs:12 when x is undefined", `expected the ORIGINAL, un-shrunk summary to survive, got: ${correctnessFinding.summary}`);
    assert.ok(!correctnessFinding.summary.endsWith(" …"), "a narrow angle's real finding must not be shrunk when it already fits the whole round");
    assert.ok(!/omitted.*ledger/.test(correctnessFinding.summary), "a narrow angle must not be marker-collapsed when its real finding already fits");

    // "style" (the actual cause of the overflow) IS collapsed to a marker.
    const styleFinding = byAngle.get("style").findings[0];
    assert.match(styleFinding.summary, /^300 finding\(s\) omitted from this comment/);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Seed-comparison regression: buildBudgetMarkedFindingsJson's INITIAL seed
// (before the upgrade loop even runs) picks whichever of {an angle's own real
// findings, its bare marker} renders cheaper in isolation — not "bare
// always wins". A single-finding angle with no file/line and a summary at or
// under the shrink floor renders its real form (62 chars, measured) SHORTER
// than its own bare "N omitted — in ledger" marker (22 chars at N=30, measured):
// angleRenderCost(real) <= angleRenderCost(bareMarker) is true, so this angle
// is seeded with its real findings directly and is then EXCLUDED from
// upgradeOrder (it never enters the per-severity upgrade walk the sibling
// "narrow angle" test above exercises) — a distinct code path from that test,
// which seeds bare first and only reaches real findings via the upgrade loop.
// Replacing the seed comparison with a plain `bareMarkers[i]` (always bare)
// passes every OTHER test in this file but flips this angle to a marker and
// fails here.
test("a narrow angle whose real findings render cheaper than its own bare marker is seeded real, not marker-collapsed", async () => {
  const files = {
    "narrow.json": {
      angle: "narrow",
      verdict: "findings_present",
      findings: [{ severity: "must-fix", summary: "x" }],
    },
    "wide.json": {
      angle: "wide",
      verdict: "findings_present",
      findings: Array.from({ length: 300 }, (_, j) => ({
        severity: "nice-to-have",
        summary: `naming nit ${j} ${"z".repeat(150)}`,
        file: `src/f${j}.mjs`,
        line: j + 1,
      })),
    },
  };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true); // the wide angle alone forces this

    const byAngle = new Map(result.findingsJson.map((a) => [a.angle, a]));
    const narrowFinding = byAngle.get("narrow").findings[0];
    assert.equal(narrowFinding.severity, "high"); // "must-fix" input normalizes to canonical "high"
    assert.equal(narrowFinding.summary, "x", "the narrow angle's real (un-shrunk, un-marked) summary must survive");
    assert.ok(!/omitted.*see (the disposition )?ledger/.test(narrowFinding.summary), "the narrow angle must not be marker-collapsed even though it never entered the upgrade loop");
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Middle-candidate regression: the upgrade loop tries an angle's real findings
// as TWO distinct candidates before falling back to a marker — the pre-shrink
// ORIGINAL first, then the already whole-round-shrunk form (findingsJson[i],
// capped at fitFindingsToRenderBudget's 31-char floor) — and only THEN the
// verbose/bare marker. An angle whose original text is too long to fit
// alongside the rest of the round, but whose shrunk form does fit, must land
// on that shrunk form (truncated real text, " …" suffix), never skip straight
// to an "omitted" marker. Deleting the middle candidate (findingsJson[i]) from
// the upgrade loop's candidate array, or reordering it after the marker,
// passes every OTHER test in this file but flips this angle straight to a
// marker and fails here.
test("an angle whose original text is too long but whose whole-round-shrunk form fits keeps the truncated real text, not a marker", async () => {
  const originalSummary = `this narrow angle carries a fairly long original finding summary text that will not fit ${"w".repeat(1900)}`;
  const files = {
    "narrow.json": {
      angle: "narrow",
      verdict: "findings_present",
      findings: [{ severity: "worth-fixing-now", summary: originalSummary }],
    },
    "wide.json": {
      angle: "wide",
      verdict: "findings_present",
      findings: Array.from({ length: 300 }, (_, j) => ({
        severity: "nice-to-have",
        summary: `naming nit ${j} ${"z".repeat(150)}`,
        file: `src/f${j}.mjs`,
        line: j + 1,
      })),
    },
  };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);

    const byAngle = new Map(result.findingsJson.map((a) => [a.angle, a]));
    const narrowFinding = byAngle.get("narrow").findings[0];
    assert.equal(narrowFinding.severity, "medium"); // "worth-fixing-now" input normalizes to canonical "medium"
    assert.ok(narrowFinding.summary.length < originalSummary.length, "the original, un-shrunk summary must not have survived (too long to fit)");
    assert.ok(originalSummary.startsWith(narrowFinding.summary.replace(/ …$/, "")), "the emitted summary must be a truncated PREFIX of the original real text");
    assert.ok(narrowFinding.summary.endsWith(" …"), "a truncated-real candidate ends with the plain ellipsis suffix, distinguishing it from an omitted-count marker");
    assert.ok(!/omitted.*see (the disposition )?ledger/.test(narrowFinding.summary), "must be the truncated real text, not an omitted-count marker");
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
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);
    assert.equal(result.findingsJson.length, ANGLE_COUNT); // real angle set preserved

    let verboseCount = 0;
    let bareCount = 0;
    for (const section of result.findingsJson) {
      assert.equal(section.verdict, "findings_present");
      assert.equal(section.findings.length, 1);
      const summary = section.findings[0].summary;
      if (summary === `${FINDINGS_PER_ANGLE} omitted — in ledger`) {
        bareCount += 1;
      } else if (summary.startsWith(`${FINDINGS_PER_ANGLE} finding(s) omitted from this comment`) && summary.endsWith("— in the disposition ledger")) {
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
// tier 3 (bare) still functions on its own, independent of the per-angle mix
// above.
test("a fan-in with enough angles that none can afford the verbose marker uses bare everywhere and still renders", async () => {
  const FINDINGS_PER_ANGLE = 30;
  // #1592: the canonical severity spellings (e.g. "medium") are shorter than
  // the pre-rename ones (e.g. "worth-fixing-now"), so a per-angle count
  // calibrated to the OLD word lengths could tip a single angle's verbose
  // marker back under the render budget. 23 (rather than 20) angles keeps
  // this fixture calibrated to the ALL-BARE tier under the new spellings —
  // still over budget for even a single verbose marker, but not yet over
  // budget for the withheld tier (see the sibling test right below this one).
  const ANGLE_COUNT = 23;
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);
    assert.equal(result.findingsJson.length, ANGLE_COUNT); // real angle set preserved
    for (const section of result.findingsJson) {
      assert.equal(section.verdict, "findings_present");
      assert.equal(section.findings.length, 1);
      // Exactly the bare sentence — never a truncated fragment of the
      // verbose one (no " …", no cut-off mid-word).
      assert.equal(section.findings[0].summary, `${FINDINGS_PER_ANGLE} omitted — in ledger`);
      assert.equal(section.findings[0].disposition, "deferred");
    }
    // The ledger is still complete regardless of how far the marker degraded.
    assert.equal(result.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
    assertRendersWithoutThrowing(result.findingsJson);
  });
});

// Budget-allocation-by-severity regression: when not every angle can afford
// the verbose marker, the scarce budget must go to the must-fix-carrying
// angle first, regardless of filename/artifact-index order. All 13 "nice-to-have"
// angles sort alphabetically BEFORE the one must-fix-carrying angle
// ("z-mustfix"), so an index/filename-ordered upgrade walk (the prior,
// reverted behavior) would spend the verbose budget on defer-only angles and
// leave the must-fix angle bare. Reverting the severity-first ordering back
// to plain index order fails this test. Both severities are LEGACY spellings
// ("must-fix"/"nice-to-have") — this also pins angleWorstSeverityRank
// ranking correctly on a legacy-spelled artifact (consolidateFanin
// normalizes on the way in, so this exercises the same end-to-end path a
// live pre-rename reviewer artifact would take).
test("the must-fix-carrying angle wins the scarce verbose-marker budget over defer-only angles regardless of file/name order", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const DEFER_ANGLE_COUNT = 13;
  const files = {};
  for (let i = 0; i < DEFER_ANGLE_COUNT; i++) {
    files[`d${String(i).padStart(2, "0")}.json`] = {
      angle: `defer-angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "nice-to-have",
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
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
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
      (a) => a.findings[0].summary === `${FINDINGS_PER_ANGLE} omitted — in ledger`,
    ).length;
    assert.ok(bareCount > 0, "fixture must force at least one angle to bare to actually exercise the allocation choice");
  });
});

// #1592: SEVERITY_ORDER ranks "question" ahead of "medium" (both defer/
// answer eventually, but a question keeps gate-close blocked the same way a
// defect does) — angleWorstSeverityRank must give the scarce verbose-marker
// budget to a question-carrying angle before a medium-only one, mirroring the
// must-fix-vs-defer-only case above.
test("the question-carrying angle wins the scarce verbose-marker budget over medium-only angles", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const MEDIUM_ANGLE_COUNT = 13;
  const files = {};
  for (let i = 0; i < MEDIUM_ANGLE_COUNT; i++) {
    files[`d${String(i).padStart(2, "0")}.json`] = {
      angle: `medium-angle-${i}`,
      verdict: "findings_present",
      findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
        severity: "medium",
        summary: `finding ${i}-${j} ${"z".repeat(150)}`,
        file: `src/f${i}.mjs`,
        line: j + 1,
      })),
    };
  }
  files["z-question.json"] = {
    angle: "question-angle",
    verdict: "findings_present",
    findings: Array.from({ length: FINDINGS_PER_ANGLE }, (_, j) => ({
      severity: "question",
      summary: `finding question-${j} ${"z".repeat(150)}`,
      file: "src/fquestion.mjs",
      line: j + 1,
    })),
  };
  await withFindingsDir(files, async (dir) => {
    const result = await consolidateGateFanin({ findingsDir: dir, ledgerOut: path.join(dir, "ledger.json") });
    assert.equal(result.ok, true);
    assert.equal(result.commentBudgetExceeded, true);

    const byAngle = new Map(result.findingsJson.map((a) => [a.angle, a]));
    const questionSummary = byAngle.get("question-angle").findings[0].summary;
    assert.match(
      questionSummary,
      new RegExp(`^${FINDINGS_PER_ANGLE} finding\\(s\\) omitted`),
      "the question-carrying angle must keep the verbose breakdown",
    );

    const bareCount = [...byAngle.values()].filter(
      (a) => a.findings[0].summary === `${FINDINGS_PER_ANGLE} omitted — in ledger`,
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
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
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
    assert.equal(writtenLedger.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
    assert.deepEqual(writtenLedger, { overallVerdict: result.overallVerdict, findings: result.findings });
  });
});

// Regression: before this guard, an over-budget round with no --ledger-out
// returned ok:true with "findingsJson": [] and no durable record anywhere —
// the marker text even points at a "disposition ledger" that was never
// written. Pre-existing behavior (before the render-budget split) failed
// closed (exit 1) on exactly this input; this must too, naming the round size
// so the caller knows to re-run with --ledger-out rather than losing the
// round silently. This pins the fail-closed behavior for any caller that
// still omits --ledger-out; every sanctioned SKILL.md gate-comment example
// now includes it.
test("an over-budget round with no --ledger-out fails closed instead of returning ok:true over zero durable evidence", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 25;
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    await assert.rejects(
      () => consolidateGateFanin({ findingsDir: dir, out: outPath }),
      /over the gate-comment render budget.*--ledger-out was not given/s,
    );
    // Nothing durable must be left behind by the rejected attempt.
    await assert.rejects(() => readFile(outPath, "utf8"), { code: "ENOENT" });
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
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
  await withFindingsDir(files, async (dir) => {
    const outPath = path.join(dir, "out", "findings.json");
    await mkdir(path.dirname(outPath), { recursive: true });
    const staleFromPriorRound = [{ angle: "angle-0", verdict: "clean", findings: [] }];
    await writeFile(outPath, JSON.stringify(staleFromPriorRound), "utf8");

    const ledgerPath = path.join(dir, "out", "ledger.json");
    const result = await consolidateGateFanin({ findingsDir: dir, out: outPath, ledgerOut: ledgerPath });
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
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
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
    assert.equal(writtenLedger.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
  });
});

test("a marker-tier round still writes a complete ledger when --out's parent directory is blocked by a regular file (mkdir EEXIST)", async () => {
  const FINDINGS_PER_ANGLE = 30;
  const ANGLE_COUNT = 14;
  const files = wideAngleFiles({ angleCount: ANGLE_COUNT, findingsPerAngle: FINDINGS_PER_ANGLE });
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
    assert.equal(writtenLedger.findings.length, ANGLE_COUNT * FINDINGS_PER_ANGLE);
  });
});

// ---------------------------------------------------------------------------
// Head-stamp guard: a stale artifact staged from an earlier round must be
// distinguishable from a fresh verdict at the reviewed head.
// ---------------------------------------------------------------------------

const HEAD_A = "a1".repeat(20);
const HEAD_B = "b2".repeat(20);

test("parseConsolidateFaninCliArgs parses and normalizes --head-sha, rejecting non-hex", () => {
  const result = parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--head-sha", HEAD_A.toUpperCase()]);
  assert.equal(result.headSha, HEAD_A);
  assert.throws(
    () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--head-sha", "not-a-sha"]),
    /--head-sha must be a 7-64 char hex SHA/,
  );
});

test("consolidateGateFanin accepts an artifact stamped with the round's head", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A });
      assert.equal(result.overallVerdict, "clean");
    },
  );
});

test("consolidateGateFanin fails closed, naming the angle, on a mismatched undeclared head stamp", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_B } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A }),
        (err) => err.message.includes('"scope"') && err.message.includes(HEAD_B) && err.message.includes(HEAD_A),
      );
    },
  );
});

test("consolidateGateFanin fails closed on a missing head stamp (unknown provenance)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A }),
        /angle "scope" has no valid "headSha" stamp/,
      );
      // A malformed stamp is the same unknown-provenance failure, not a bypass.
      await writeFile(path.join(dir, "scope.json"), JSON.stringify({ angle: "scope", verdict: "clean", findings: [], headSha: "zz-not-hex" }), "utf8");
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A }),
        /angle "scope" has no valid "headSha" stamp/,
      );
    },
  );
});

test("consolidateGateFanin exempts a declared carried-forward angle from the head-stamp check", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    await withFindingsDir(
      {
        "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A },
        "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_B },
      },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          headSha: HEAD_A,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["coverage"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["coverage"], { carriedFromHead: HEAD_B })).carried,
        });
        // The real artifact wins for the carried angle (existing behavior);
        // provenance stays the plan's carriedFromHead, no second field.
        assert.deepEqual(result.angles.map((a) => a.angle).sort(), ["coverage", "scope"]);
      },
    );
  });
});

test("consolidateGateFanin without --head-sha keeps the pre-stamp behavior for unstamped artifacts", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir });
      assert.equal(result.overallVerdict, "clean");
    },
  );
});

test("consolidateGateFanin normalizes a mixed-case stamp and a programmatic mixed-case headSha", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: `  ${HEAD_A.toUpperCase()}  ` } },
    async (dir) => {
      const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A.toUpperCase() });
      assert.equal(result.overallVerdict, "clean");
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, headSha: "not hex" }),
        /--head-sha must be a 7-64 char hex SHA/,
      );
    },
  );
});

test("consolidateGateFanin lets a blocked artifact reach the blocked-verdict path, not the stamp guard", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "blocked", error: "sentinel refused", findings: [] } },
    async (dir) => {
      await assert.rejects(
        () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A }),
        /fan-in is blocked .* re-run that reviewer/,
      );
    },
  );
});

test("consolidateGateFanin rejects a non-string programmatic headSha (no coercion)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A } },
    async (dir) => {
      for (const bad of [123, ["a1".repeat(20)], { sha: HEAD_A }]) {
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: bad }),
          /--head-sha must be a 7-64 char hex SHA string/,
        );
      }
    },
  );
});

test("consolidateGateFanin exempts a carried angle case-insensitively but never a delta-sibling by base name", async () => {
  await withMinimalConfigRepoRoot(async (repoRoot) => {
    // Case-insensitive exact-name match: "Coverage" exempts a "coverage" artifact.
    await withFindingsDir(
      { "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_B } },
      async (dir) => {
        const result = await consolidateGateFanin({
          findingsDir: dir,
          headSha: HEAD_A,
          gate: "draft_gate",
          repoRoot,
          carriedAngles: ["Coverage"],
          carryForwardPlan: JSON.parse(carryForwardPlanJson(["Coverage"], { carriedFromHead: HEAD_B })).carried,
        });
        assert.equal(result.ok, true);
      },
    );
    // No baseAngleName collapse: a fresh -delta-at-<sha> sibling is NOT exempted
    // by its base being carried — its stale stamp still fails closed.
    await withFindingsDir(
      { "coverage-delta.json": { angle: "coverage-delta-at-abc1234", verdict: "clean", findings: [], headSha: HEAD_B } },
      async (dir) => {
        await assert.rejects(
          () => consolidateGateFanin({
            findingsDir: dir,
            headSha: HEAD_A,
            gate: "draft_gate",
            repoRoot,
            carriedAngles: ["coverage"],
            carryForwardPlan: JSON.parse(carryForwardPlanJson(["coverage"], { carriedFromHead: HEAD_B })).carried,
          }),
          /coverage-delta-at-abc1234.*stamped for head/,
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// GATE-EXEC-BRIEFING-PREFIX fan-in integration (#1618): consolidate-fanin MUST
// run verify-briefing-prefixes before consolidation. The verifier had ZERO
// callers before this. Each behavior below has a test that fails when reverted
// (proven by mutation). Sentinel files live directly under <tmpRoot>/ (the tmp/
// directory) and are read
// by verifyBriefingPrefixesForHead; the findings artifacts carry headSha stamps
// matching the round head so the head-stamp guard does not fire first.
// ---------------------------------------------------------------------------

async function writePrefixSentinel(tmpRoot, scope, headSha, prefixHash) {
  await mkdir(tmpRoot, { recursive: true });
  const body = { scope, ...(prefixHash === null ? {} : { prefixHash }) };
  await writeFile(
    path.join(tmpRoot, `checkpoint-context-sentinel-${scope}-${headSha}.json`),
    `${JSON.stringify(body)}\n`,
    "utf8",
  );
}

// A round whose reviewers all recorded the SAME prefix hash consolidates (the
// invariant-briefing prefix was byte-identical across reviewers). This is the
// baseline the fail-closed tests below mutate against.
test("#1618 AC: a round whose sentinels share one prefix hash consolidates", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, "a".repeat(64));
        const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 2 });
        assert.equal(result.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC4: a head with NO sentinels at all still consolidates — offline/inline/test
// paths where the fresh-context guard was never invoked stay byte-identical. The
// count check is skipped (reviewerCount === 0), even with expectedDispatchUnits.
test("#1618 AC4: a head with no sentinels still consolidates (offline/test path unchanged)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A } },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 3 });
        assert.equal(result.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC1: two sentinels for the head recording DISTINCT prefix hashes → fail
// closed (a seeded-briefing divergence, the mid-flight-rebuild case). Mutation:
// revert the verifyBriefingPrefixesForHead call and this passes (the divergence
// is silently consolidated) — so the test fails when reverted.
test("#1618 AC1: consolidation fails closed when two sentinels record distinct prefix hashes", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, "b".repeat(64));
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot }),
          (err) => err.message.includes("GATE-EXEC-BRIEFING-PREFIX") && /DIFFERENT.*prefix hash/i.test(err.message),
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC2: any sentinel for the head recording NO prefix hash → fail closed (the
// proof was never established for that reviewer — never grandfathered).
test("#1618 AC2: consolidation fails closed when a sentinel is hashless", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, null);
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot }),
          (err) => err.message.includes("GATE-EXEC-BRIEFING-PREFIX") && /no recorded prefix hash/i.test(err.message),
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC3 (per-angle framing): expectedDispatchUnits = non-carried angle count, and
// the sentinel count is short of it → fail closed (a dispatched reviewer never
// ran the fresh-context guard). expectedDispatchUnits is the dispatch-UNIT
// count; in per-angle dispatch one unit == one angle, so it equals the angle
// count here.
test("#1618 AC3 (per-angle): fails closed when sentinel count < expected dispatch-unit count", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // Only ONE of two dispatched reviewers wrote a sentinel.
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 2 }),
          (err) => err.message.includes("GATE-EXEC-BRIEFING-PREFIX")
            && /sentinel count \(1\) is short of the expected dispatch-unit count \(2\)/.test(err.message),
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC3 (grouped framing): grouped dispatch writes one sentinel per GROUP. Two
// angles in ONE group → expectedDispatchUnits=1, and one sentinel SATISFIES it
// (the non-regression case for #1579/#1601 grouped fan-out — comparing against
// the angle count would false-fail here). Two groups with only one sentinel →
// fail closed.
test("#1618 AC3 (grouped): one sentinel per group — count is the dispatch-UNIT count, not the angle count", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // Two angles in ONE group → one sentinel satisfies expectedDispatchUnits=1.
        // (A literal "sentinel count < angle count" check would false-fail here —
        // this is the regression guard for grouped fan-out.)
        await writePrefixSentinel(tmpRoot, "draft-gate-group-correctness-input", HEAD_A, "a".repeat(64));
        const ok = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 1 });
        assert.equal(ok.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

test("#1618 AC3 (grouped): fails closed when sentinel count < group count", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // Two groups dispatched, only one reviewer wrote a sentinel.
        await writePrefixSentinel(tmpRoot, "draft-gate-group-a", HEAD_A, "a".repeat(64));
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 2 }),
          /sentinel count \(1\) is short of the expected dispatch-unit count \(2\)/,
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// AC3 is skipped (not enforced) when expectedDispatchUnits is omitted — the hash
// checks (AC1/AC2) still run. This preserves backward compatibility for callers
// that have not yet threaded the dispatch-unit count.
test("#1618: without --expected-dispatch-units the count check is skipped (hash checks still run)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A } },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // One sentinel for a one-angle round; no expectedDispatchUnits declared.
        await writePrefixSentinel(tmpRoot, "draft-gate-scope", HEAD_A, "a".repeat(64));
        const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot });
        assert.equal(result.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// The briefing-prefix check only runs when --head-sha is given (the same
// boundary the artifact head-stamp guard uses). Without --head-sha, a divergent
// sentinel population does not block consolidation (offline/legacy path).
test("#1618: the briefing-prefix check only runs with --head-sha (no head-sha = no check)", async () => {
  await withFindingsDir(
    { "scope.json": { angle: "scope", verdict: "clean", findings: [] } },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // Divergent hashes that WOULD fail AC1 — but no headSha, so no check.
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, "b".repeat(64));
        const result = await consolidateGateFanin({ findingsDir: dir, tmpRoot });
        assert.equal(result.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

// CLI parsing: --expected-dispatch-units must be a positive integer.
test("parseConsolidateFaninCliArgs parses --expected-dispatch-units and rejects non-positive-int", () => {
  const ok = parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--head-sha", HEAD_A, "--expected-dispatch-units", "3"]);
  assert.equal(ok.expectedDispatchUnits, 3);
  assert.equal(ok.tmpRoot, undefined);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.throws(
      () => parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--head-sha", HEAD_A, "--expected-dispatch-units", bad]),
      /--expected-dispatch-units must be a positive integer/,
    );
  }
});

test("parseConsolidateFaninCliArgs parses --tmp-root", () => {
  const ok = parseConsolidateFaninCliArgs(["--findings-dir", "/tmp/x", "--head-sha", HEAD_A, "--tmp-root", "/var/tmp"]);
  assert.equal(ok.tmpRoot, "/var/tmp");
});

// ---------------------------------------------------------------------------
// #1618 record-matching path: when on-disk per-gate briefing-prefix records
// exist, consolidate-fanin's verifier exercises the record-matching branch
// (not only the flat fallback the tests above cover). A sentinel whose hash
// matches a gate record consolidates; a sentinel whose hash matches NO record
// fails closed (the production path — write-gate-context persists records).
// ---------------------------------------------------------------------------

async function writeGateBriefingRecord(tmpRoot, gate, headSha, bytes) {
  const dir = path.join(tmpRoot, "gate-context", "mfittko-dev-loops", "pr-1646");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${gate}-${headSha}.briefing-prefix.txt`), bytes);
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

test("#1618 record-matching: sentinels whose hashes match an on-disk gate record consolidate", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        const hash = await writeGateBriefingRecord(tmpRoot, "draft_gate", HEAD_A, "invariant briefing bytes");
        // Both sentinels record the SAME hash that matches the draft_gate record.
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, hash);
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, hash);
        const result = await consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot, expectedDispatchUnits: 2 });
        assert.equal(result.overallVerdict, "clean");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

test("#1618 record-matching: a sentinel whose hash matches NO gate record fails closed", async () => {
  await withFindingsDir(
    {
      "coverage.json": { angle: "coverage", verdict: "clean", findings: [], headSha: HEAD_A },
      "correctness.json": { angle: "correctness", verdict: "clean", findings: [], headSha: HEAD_A },
    },
    async (dir) => {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "consolidate-fanin-prefix-"));
      try {
        // A gate record exists, but the sentinels record a DIFFERENT hash.
        await writeGateBriefingRecord(tmpRoot, "draft_gate", HEAD_A, "invariant briefing bytes");
        await writePrefixSentinel(tmpRoot, "draft-gate-coverage", HEAD_A, "a".repeat(64));
        await writePrefixSentinel(tmpRoot, "draft-gate-correctness", HEAD_A, "a".repeat(64));
        await assert.rejects(
          () => consolidateGateFanin({ findingsDir: dir, headSha: HEAD_A, tmpRoot }),
          (err) => err.message.includes("GATE-EXEC-BRIEFING-PREFIX") && /matches no gate briefing-prefix record/i.test(err.message),
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
