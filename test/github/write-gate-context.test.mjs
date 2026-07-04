import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveGateAnglesDynamic } from "@dev-loops/core/config";

import {
  buildGateContext,
  buildGateContextArtifact,
  buildGateContextPath,
  buildGateDiffPath,
  mapGateToConfigKey,
  parseChangedFiles,
  parseWriteGateContextCliArgs,
  rationaleFromResolver,
  readGateContext,
  writeGateContext,
} from "../../scripts/github/write-gate-context.mjs";

function draftConfig(overrides = {}) {
  return {
    version: 1,
    gates: {
      draft: {
        angles: ["scope", "coverage", "correctness", "docs", "link-check", "config-drift"],
        mandatoryAngles: ["gate-evidence"],
        excludeAngles: [],
        dynamicAngles: true,
        ...overrides,
      },
    },
  };
}

const DOCS_ONLY_DIFF = {
  nameStatusOutput: "M\tdocs/foo.md\nM\tREADME.md\n",
  diffOutput: "",
};

// ---------------------------------------------------------------------------
// Path builder
// ---------------------------------------------------------------------------

test("buildGateContextPath produces a deterministic slugged path", () => {
  const p = buildGateContextPath({
    repo: "owner/repo",
    pr: 42,
    gate: "draft_gate",
    headSha: "abc1234",
    tmpRoot: "tmp",
  });
  assert.equal(p, path.join("tmp", "gate-context", "owner-repo", "pr-42", "draft_gate-abc1234.json"));
});

test("buildGateContextPath honors custom tmp-root", () => {
  const p = buildGateContextPath({
    repo: "a/b",
    pr: 1,
    gate: "pre_approval_gate",
    headSha: "deadbeef",
    tmpRoot: "custom",
  });
  assert.equal(p, path.join("custom", "gate-context", "a-b", "pr-1", "pre_approval_gate-deadbeef.json"));
});

test("buildGateContextPath rejects malformed repo", () => {
  assert.throws(() => buildGateContextPath({ repo: "no-slash", pr: 1, gate: "draft_gate", headSha: "abc1234" }), /owner\/name/);
  assert.throws(() => buildGateContextPath({ repo: "../x/y", pr: 1, gate: "draft_gate", headSha: "abc1234" }), /owner\/name|unsafe/);
});

test("buildGateContextPath lowercases the headSha segment (case-canonical, matches normalizeHeadSha)", () => {
  // A mixed-case headRefOid must compute the SAME filename as its lowercase form
  // so readGateContext / the .diff lookup never misses it (determinism).
  const p = buildGateContextPath({ repo: "owner/repo", pr: 7, gate: "pre_approval_gate", headSha: "ABC1234def" });
  assert.equal(p, path.join("tmp", "gate-context", "owner-repo", "pr-7", "pre_approval_gate-abc1234def.json"));
  // Upper- and lower-case SHAs resolve to the same path.
  assert.equal(
    buildGateContextPath({ repo: "owner/repo", pr: 7, gate: "pre_approval_gate", headSha: "ABC1234DEF" }),
    buildGateContextPath({ repo: "owner/repo", pr: 7, gate: "pre_approval_gate", headSha: "abc1234def" }),
  );
});

test("buildGateContextPath accepts a whitespace-padded canonical pr (trims to digits)", () => {
  const p = buildGateContextPath({ repo: "owner/repo", pr: " 9 ", gate: "draft_gate", headSha: "abc1234" });
  assert.equal(p, path.join("tmp", "gate-context", "owner-repo", "pr-9", "draft_gate-abc1234.json"));
});

test("buildGateContextPath rejects unsafe pr/gate/headSha segments", () => {
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: 1, gate: "../etc", headSha: "abc1234" }), /gate.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: "1.5", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: "../9", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: 0, gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  // Non-canonical numeric forms that Number() would silently coerce to a DIFFERENT
  // pr-<N> segment than the CLI's parsePrNumber (`/^\d+$/`) would accept.
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: "1e3", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: "0x10", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: "abc", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: "../../etc/passwd" }), /head-sha.*unsafe/);
  assert.throws(() => buildGateContextPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: "xyz" }), /head-sha.*unsafe/);
});

// ---------------------------------------------------------------------------
// Diff path builder (mirrors buildGateContextPath, .diff extension)
// ---------------------------------------------------------------------------

test("buildGateDiffPath produces a deterministic slugged .diff path", () => {
  const p = buildGateDiffPath({
    repo: "owner/repo",
    pr: 42,
    gate: "draft_gate",
    headSha: "abc1234",
    tmpRoot: "tmp",
  });
  assert.equal(p, path.join("tmp", "gate-context", "owner-repo", "pr-42", "draft_gate-abc1234.diff"));
});

test("buildGateDiffPath honors custom tmp-root and sits beside the context artifact", () => {
  const diffPath = buildGateDiffPath({ repo: "a/b", pr: 1, gate: "pre_approval_gate", headSha: "deadbeef", tmpRoot: "custom" });
  const jsonPath = buildGateContextPath({ repo: "a/b", pr: 1, gate: "pre_approval_gate", headSha: "deadbeef", tmpRoot: "custom" });
  assert.equal(diffPath, path.join("custom", "gate-context", "a-b", "pr-1", "pre_approval_gate-deadbeef.diff"));
  assert.equal(path.dirname(diffPath), path.dirname(jsonPath));
});

test("buildGateDiffPath rejects malformed repo (same safety as context path)", () => {
  assert.throws(() => buildGateDiffPath({ repo: "no-slash", pr: 1, gate: "draft_gate", headSha: "abc1234" }), /owner\/name/);
  assert.throws(() => buildGateDiffPath({ repo: "../x/y", pr: 1, gate: "draft_gate", headSha: "abc1234" }), /owner\/name|unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "a b/c", pr: 1, gate: "draft_gate", headSha: "abc1234" }), /unsafe/);
});

test("buildGateDiffPath lowercases the headSha segment (case-canonical, matches the context path)", () => {
  const p = buildGateDiffPath({ repo: "owner/repo", pr: 7, gate: "pre_approval_gate", headSha: "ABC1234def" });
  assert.equal(p, path.join("tmp", "gate-context", "owner-repo", "pr-7", "pre_approval_gate-abc1234def.diff"));
  // The .diff and .json siblings must agree on the lowercased SHA so a scoped
  // reviewer that found the JSON also finds the diff.
  const jsonPath = buildGateContextPath({ repo: "owner/repo", pr: 7, gate: "pre_approval_gate", headSha: "ABC1234def" });
  assert.equal(path.basename(p, ".diff"), path.basename(jsonPath, ".json"));
});

test("buildGateDiffPath rejects unsafe pr/gate/headSha segments (same safety as context path)", () => {
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: 1, gate: "../etc", headSha: "abc1234" }), /gate.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: "1.5", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: "../9", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: 0, gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: "1e3", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: "0x10", gate: "draft_gate", headSha: "abc1234" }), /pr.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: "../../etc/passwd" }), /head-sha.*unsafe/);
  assert.throws(() => buildGateDiffPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: "xyz" }), /head-sha.*unsafe/);
});

// ---------------------------------------------------------------------------
// parseChangedFiles — full repo-relative paths from --name-status output
// ---------------------------------------------------------------------------

test("parseChangedFiles parses M/A/D entries and tolerates blanks", () => {
  const out = "M\tscripts/a.mjs\nA\tscripts/b.mjs\n\nD\tdocs/old.md\n";
  assert.deepEqual(parseChangedFiles(out), ["scripts/a.mjs", "scripts/b.mjs", "docs/old.md"]);
});

test("parseChangedFiles records destination path for renames/copies", () => {
  const out = "R100\tsrc/old.mjs\tsrc/new.mjs\nC75\tsrc/base.mjs\tsrc/copy.mjs\n";
  assert.deepEqual(parseChangedFiles(out), ["src/new.mjs", "src/copy.mjs"]);
});

test("parseChangedFiles records the new path for a well-formed 3-column rename/copy", () => {
  assert.deepEqual(parseChangedFiles("R100\told\tnew\n"), ["new"]);
  assert.deepEqual(parseChangedFiles("C75\ta\tb\n"), ["b"]);
});

test("parseChangedFiles skips a malformed 2-column rename/copy row (no new path)", () => {
  // "R100\told" lacks the destination column; recording the OLD path would be wrong.
  assert.deepEqual(parseChangedFiles("R100\told\n"), []);
  assert.deepEqual(parseChangedFiles("C75\tonly-old\n"), []);
  // Malformed rename row is skipped but valid neighbors are still recorded.
  assert.deepEqual(
    parseChangedFiles("R100\told\nM\tkept.mjs\nR50\tx\ty\n"),
    ["kept.mjs", "y"],
  );
});

test("parseChangedFiles returns empty for empty/non-string input", () => {
  assert.deepEqual(parseChangedFiles(""), []);
  assert.deepEqual(parseChangedFiles(undefined), []);
  assert.deepEqual(parseChangedFiles(null), []);
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test("parseWriteGateContextCliArgs parses required args", () => {
  const result = parseWriteGateContextCliArgs([
    "--repo", "owner/repo",
    "--pr", "42",
    "--gate", "draft_gate",
    "--head-sha", "abc1234567890abcdef",
    "--angles", '["scope","correctness"]',
  ]);
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.pr, 42);
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.headSha, "abc1234567890abcdef");
  assert.deepEqual(result.angles, ["scope", "correctness"]);
  assert.equal(result.tmpRoot, "tmp");
});

test("parseWriteGateContextCliArgs parses optional scope + rationale", () => {
  const result = parseWriteGateContextCliArgs([
    "--repo", "a/b", "--pr", "3", "--gate", "pre_approval_gate",
    "--head-sha", "deadbeef1234567890",
    "--angles", '["scope"]',
    "--rationale", '[{"angle":"coverage","action":"dropped","reason":"docs-only"}]',
    "--branch", "issue-877",
    "--touched-files", '["docs/x.md"]',
    "--acceptance-criteria", "#877",
    "--validation-posture", "npm run verify",
  ]);
  assert.deepEqual(result.rationale, [{ angle: "coverage", action: "dropped", reason: "docs-only" }]);
  assert.equal(result.branch, "issue-877");
  assert.deepEqual(result.touchedFiles, ["docs/x.md"]);
  assert.equal(result.acceptanceCriteria, "#877");
  assert.equal(result.validationPosture, "npm run verify");
});

test("parseWriteGateContextCliArgs rejects invalid gate", () => {
  assert.throws(() => parseWriteGateContextCliArgs([
    "--repo", "a/b", "--pr", "1", "--gate", "bad", "--head-sha", "abc1234", "--angles", "[]",
  ]), /gate/);
});

test("parseWriteGateContextCliArgs rejects invalid head-sha", () => {
  assert.throws(() => parseWriteGateContextCliArgs([
    "--repo", "a/b", "--pr", "1", "--gate", "draft_gate", "--head-sha", "zzz", "--angles", "[]",
  ]), /head-sha/);
});

test("parseWriteGateContextCliArgs rejects non-array angles", () => {
  assert.throws(() => parseWriteGateContextCliArgs([
    "--repo", "a/b", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234", "--angles", "{}",
  ]), /array/);
});

test("parseWriteGateContextCliArgs rejects bad rationale action", () => {
  assert.throws(() => parseWriteGateContextCliArgs([
    "--repo", "a/b", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234",
    "--angles", '["scope"]',
    "--rationale", '[{"angle":"scope","action":"bogus","reason":"x"}]',
  ]), /action/);
});

test("parseWriteGateContextCliArgs reports missing required args", () => {
  assert.throws(() => parseWriteGateContextCliArgs(["--repo", "a/b"]), /Missing required/);
});

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

test("buildGateContextArtifact records angles + rationale + scope", () => {
  const artifact = buildGateContextArtifact({
    repo: "a/b", pr: 5, gate: "draft_gate", headSha: "abc1234",
    angles: ["scope"],
    rationale: [{ angle: "scope", action: "kept", reason: "relevant" }],
    branch: "feat", touchedFiles: ["x.mjs"],
    acceptanceCriteria: "#5", validationPosture: "npm test",
  });
  assert.deepEqual(artifact.resolvedAngles, ["scope"]);
  assert.equal(artifact.rationale.length, 1);
  assert.deepEqual(artifact.scope, {
    branch: "feat",
    headSha: "abc1234",
    touchedFiles: ["x.mjs"],
    changedFiles: [],
    diffPath: null,
    acceptanceCriteria: "#5",
    validationPosture: "npm test",
  });
});

// ---------------------------------------------------------------------------
// Write / read round-trip
// ---------------------------------------------------------------------------

test("writeGateContext + readGateContext round-trip", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const options = parseWriteGateContextCliArgs([
      "--repo", "owner/repo", "--pr", "7", "--gate", "draft_gate",
      "--head-sha", "abc1234567890",
      "--angles", '["scope","docs"]',
      "--rationale", '[{"angle":"scope","action":"kept","reason":"relevant"}]',
      "--branch", "issue-877",
      "--touched-files", '["docs/a.md"]',
      "--acceptance-criteria", "#877",
      "--validation-posture", "npm run verify",
    ]);
    const writeResult = await writeGateContext(options, { repoRoot });

    assert.equal(writeResult.ok, true);
    assert.equal(
      writeResult.path,
      path.join("tmp", "gate-context", "owner-repo", "pr-7", "draft_gate-abc1234567890.json"),
    );

    const onDisk = JSON.parse(await readFile(path.resolve(repoRoot, writeResult.path), "utf8"));
    assert.deepEqual(onDisk.resolvedAngles, ["scope", "docs"]);
    assert.equal(onDisk.scope.branch, "issue-877");
    assert.equal(typeof onDisk.loggedAt, "string");

    const reread = await readGateContext({
      repo: "owner/repo", pr: 7, gate: "draft_gate", headSha: "abc1234567890",
    }, { repoRoot });
    assert.deepEqual(reread.resolvedAngles, ["scope", "docs"]);
    assert.deepEqual(reread.scope.touchedFiles, ["docs/a.md"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("readGateContext returns null when artifact absent", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const result = await readGateContext({
      repo: "owner/repo", pr: 999, gate: "draft_gate", headSha: "abc1234",
    }, { repoRoot });
    assert.equal(result, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate-name mapping
// ---------------------------------------------------------------------------

test("mapGateToConfigKey maps artifact gate names to config keys", () => {
  assert.equal(mapGateToConfigKey("draft_gate"), "draft");
  assert.equal(mapGateToConfigKey("pre_approval_gate"), "preApproval");
  assert.throws(() => mapGateToConfigKey("bogus"), /Unknown gate/);
});

// ---------------------------------------------------------------------------
// rationaleFromResolver — maps resolver output, does not re-derive angles
// ---------------------------------------------------------------------------

test("rationaleFromResolver maps recommended→kept and skipped→dropped with reasons", () => {
  const { resolvedAngles, rationale } = rationaleFromResolver({
    recommendedAngles: ["gate-evidence", "docs"],
    skippedAngles: ["coverage"],
    reasons: { coverage: "DOCS_ONLY" },
    dynamicAnglesActive: true,
  });
  assert.deepEqual(resolvedAngles, ["gate-evidence", "docs"]);
  assert.deepEqual(rationale.find((r) => r.angle === "gate-evidence"), {
    angle: "gate-evidence", action: "kept", reason: "selected by dynamic angle resolver",
  });
  assert.deepEqual(rationale.find((r) => r.angle === "coverage"), {
    angle: "coverage", action: "dropped", reason: "DOCS_ONLY",
  });
});

test("rationaleFromResolver marks kept angles as static when dynamic resolution is inactive", () => {
  const { rationale } = rationaleFromResolver({
    recommendedAngles: ["gate-evidence", "coverage"],
    skippedAngles: [],
    reasons: {},
    dynamicAnglesActive: false,
  });
  for (const r of rationale) {
    assert.equal(r.action, "kept");
    assert.equal(r.reason, "static pool (dynamic angle resolution inactive)");
  }
});

test("rationaleFromResolver tolerates null/empty resolver output", () => {
  const { resolvedAngles, rationale } = rationaleFromResolver({ recommendedAngles: null });
  assert.deepEqual(resolvedAngles, []);
  assert.deepEqual(rationale, []);
});

test("rationaleFromResolver marks addedAngles entries as 'added' with their addedReasons, not 'kept' (#1048)", () => {
  const { resolvedAngles, rationale } = rationaleFromResolver({
    recommendedAngles: ["gate-evidence", "docs", "ci-guard"],
    skippedAngles: ["coverage"],
    reasons: { coverage: "DOCS_ONLY" },
    addedAngles: ["ci-guard"],
    addedReasons: { "ci-guard": "Added: triggered by change category CI_ONLY" },
    dynamicAnglesActive: true,
  });
  assert.deepEqual(resolvedAngles, ["gate-evidence", "docs", "ci-guard"]);
  assert.deepEqual(rationale.find((r) => r.angle === "ci-guard"), {
    angle: "ci-guard", action: "added", reason: "Added: triggered by change category CI_ONLY",
  });
  // Not also recorded as kept
  assert.equal(rationale.filter((r) => r.angle === "ci-guard").length, 1);
  assert.deepEqual(rationale.find((r) => r.angle === "gate-evidence"), {
    angle: "gate-evidence", action: "kept", reason: "selected by dynamic angle resolver",
  });
});

test("rationaleFromResolver treats addedAngles entries as 'kept' when dynamicAnglesActive is not true (defensive guard)", () => {
  // resolveGateAnglesDynamic never produces a non-empty addedAngles with
  // dynamicAnglesActive false, but a hand-constructed/malformed resolverResult
  // could. The "added" classification must stay gated on dynamicActive so
  // rationale semantics remain internally consistent.
  const { rationale } = rationaleFromResolver({
    recommendedAngles: ["some-angle"],
    skippedAngles: [],
    reasons: {},
    addedAngles: ["some-angle"],
    addedReasons: { "some-angle": "Added: triggered by change category CI_ONLY" },
    dynamicAnglesActive: false,
  });
  assert.deepEqual(rationale, [
    { angle: "some-angle", action: "kept", reason: "static pool (dynamic angle resolution inactive)" },
  ]);
});

test("rationaleFromResolver marks a mandatory angle absent from addedAngles as 'kept', not 'added' (#1136 regression)", () => {
  // Mirrors resolveGateAnglesDynamic's fixed output shape: renderer-security is
  // in recommendedAngles (mandatory floor) but excluded from addedAngles because
  // it's mandatory, even though it also appears in the anglePool catalog.
  const { resolvedAngles, rationale } = rationaleFromResolver({
    recommendedAngles: ["renderer-security", "scope", "contract-surface"],
    skippedAngles: [],
    reasons: {},
    addedAngles: ["contract-surface"],
    addedReasons: { "contract-surface": "Added: triggered by change category LOGIC_CHANGE" },
    dynamicAnglesActive: true,
  });
  assert.deepEqual(resolvedAngles, ["renderer-security", "scope", "contract-surface"]);
  assert.deepEqual(rationale.find((r) => r.angle === "renderer-security"), {
    angle: "renderer-security", action: "kept", reason: "selected by dynamic angle resolver",
  });
  assert.deepEqual(rationale.find((r) => r.angle === "contract-surface"), {
    angle: "contract-surface", action: "added", reason: "Added: triggered by change category LOGIC_CHANGE",
  });
});

test("rationaleFromResolver falls back to a sane default reason for an added angle with no addedReasons entry", () => {
  const { rationale } = rationaleFromResolver({
    recommendedAngles: ["ci-guard"],
    skippedAngles: [],
    reasons: {},
    addedAngles: ["ci-guard"],
    addedReasons: {},
    dynamicAnglesActive: true,
  });
  assert.deepEqual(rationale, [
    { angle: "ci-guard", action: "added", reason: "added by dynamic angle resolver (catalog addition)" },
  ]);
});

// ---------------------------------------------------------------------------
// buildGateContext — integration with the canonical resolver
// ---------------------------------------------------------------------------

test("buildGateContext persists resolveGateAnglesDynamic output (docs-only)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig();

    // Verify against the canonical resolver directly (single source of truth).
    const resolver = await resolveGateAnglesDynamic(config, "draft", { diff: DOCS_ONLY_DIFF });
    assert.equal(resolver.dynamicAnglesActive, true);

    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff: DOCS_ONLY_DIFF,
        repo: "owner/repo",
        pr: 12,
        headSha: "abc1234567890",
        branch: "issue-877",
        touchedFiles: ["docs/foo.md", "README.md"],
        acceptanceCriteria: "#877",
        validationPosture: "npm run verify",
      },
      { repoRoot },
    );

    // resolvedAngles mirror the resolver's recommendedAngles exactly.
    assert.deepEqual(result.artifact.resolvedAngles, resolver.recommendedAngles);

    // Mandatory floor present in resolvedAngles.
    assert.ok(result.artifact.resolvedAngles.includes("gate-evidence"));

    // Dropped angles (skipped by the resolver) appear in rationale as 'dropped'.
    for (const dropped of resolver.skippedAngles) {
      const entry = result.artifact.rationale.find((r) => r.angle === dropped);
      assert.equal(entry.action, "dropped");
      assert.equal(entry.reason, resolver.reasons[dropped]);
    }
    // docs-only drops code lenses.
    assert.ok(!result.artifact.resolvedAngles.includes("coverage"));
    assert.ok(result.artifact.rationale.some((r) => r.angle === "coverage" && r.action === "dropped"));

    // Scope persisted. DOCS_ONLY_DIFF has empty diffOutput, so diffPath is null
    // and changedFiles is parsed from nameStatusOutput.
    assert.deepEqual(result.artifact.scope, {
      branch: "issue-877",
      headSha: "abc1234567890",
      touchedFiles: ["docs/foo.md", "README.md"],
      changedFiles: ["docs/foo.md", "README.md"],
      diffPath: null,
      acceptanceCriteria: "#877",
      validationPosture: "npm run verify",
    });

    // Round-trips on disk.
    const onDisk = await readGateContext({
      repo: "owner/repo", pr: 12, gate: "draft_gate", headSha: "abc1234567890",
    }, { repoRoot });
    assert.deepEqual(onDisk.resolvedAngles, resolver.recommendedAngles);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildGateContext with dynamicAngles=off persists the static pool, all kept", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig({ dynamicAngles: false });
    const resolver = await resolveGateAnglesDynamic(config, "draft", { diff: DOCS_ONLY_DIFF });
    assert.equal(resolver.dynamicAnglesActive, false);

    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff: DOCS_ONLY_DIFF,
        repo: "owner/repo",
        pr: 13,
        headSha: "deadbeef1234",
      },
      { repoRoot },
    );

    // Static pool preserved unchanged (no drops) — matches resolver output.
    assert.deepEqual(result.artifact.resolvedAngles, resolver.recommendedAngles);
    assert.ok(result.artifact.resolvedAngles.includes("coverage")); // not dropped
    assert.ok(result.artifact.resolvedAngles.includes("gate-evidence")); // mandatory floor
    // No 'dropped' rationale entries in static mode.
    assert.ok(result.artifact.rationale.every((r) => r.action === "kept"));
    assert.equal(result.artifact.rationale.length, resolver.recommendedAngles.length);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildGateContext maps pre_approval_gate to the preApproval config key", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = {
      version: 1,
      gates: {
        preApproval: {
          angles: ["dry", "kiss", "docs"],
          mandatoryAngles: ["renderer-security"],
          excludeAngles: [],
          dynamicAngles: true,
        },
      },
    };
    const result = await buildGateContext(
      {
        config,
        gate: "pre_approval_gate",
        diff: DOCS_ONLY_DIFF,
        repo: "a/b",
        pr: 14,
        headSha: "feedface1234",
      },
      { repoRoot },
    );
    // Mandatory floor honored for the preApproval gate.
    assert.ok(result.artifact.resolvedAngles.includes("renderer-security"));
    assert.equal(result.artifact.gate, "pre_approval_gate");
    assert.equal(result.path, path.join("tmp", "gate-context", "a-b", "pr-14", "pre_approval_gate-feedface1234.json"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildGateContext — full-diff capture
// ---------------------------------------------------------------------------

test("buildGateContext writes the .diff file and records scope.diffPath + scope.changedFiles when diffOutput is present", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig();
    const diffOutput = [
      "diff --git a/scripts/a.mjs b/scripts/a.mjs",
      "index 111..222 100644",
      "--- a/scripts/a.mjs",
      "+++ b/scripts/a.mjs",
      "@@ -1,3 +1,4 @@",
      "+const added = parseFloat(input);",
      "diff --git a/scripts/b.mjs b/scripts/b.mjs",
      "+more",
    ].join("\n");
    const diff = {
      nameStatusOutput: "M\tscripts/a.mjs\nA\tscripts/b.mjs\n",
      diffOutput,
    };

    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff,
        repo: "owner/repo",
        pr: 20,
        headSha: "abc1234567890",
      },
      { repoRoot },
    );

    const expectedDiffPath = buildGateDiffPath({
      repo: "owner/repo", pr: 20, gate: "draft_gate", headSha: "abc1234567890",
    });
    assert.equal(result.artifact.scope.diffPath, expectedDiffPath);
    assert.deepEqual(result.artifact.scope.changedFiles, ["scripts/a.mjs", "scripts/b.mjs"]);

    // The full diff is written to the .diff file, NOT inlined in the JSON.
    const onDiskDiff = await readFile(path.resolve(repoRoot, expectedDiffPath), "utf8");
    assert.ok(onDiskDiff.includes("diff --git a/scripts/a.mjs"));
    assert.ok(onDiskDiff.includes("const added = parseFloat(input);"));
    const onDiskJson = await readFile(
      path.resolve(repoRoot, result.path),
      "utf8",
    );
    assert.ok(!onDiskJson.includes("diff --git"), "diff body must not be embedded inline in the JSON artifact");

    // Round-trips through readGateContext.
    const reread = await readGateContext({
      repo: "owner/repo", pr: 20, gate: "draft_gate", headSha: "abc1234567890",
    }, { repoRoot });
    assert.equal(reread.scope.diffPath, expectedDiffPath);
    assert.deepEqual(reread.scope.changedFiles, ["scripts/a.mjs", "scripts/b.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildGateContext leaves scope.diffPath null when diffOutput is absent (still records changedFiles)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig();
    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff: { nameStatusOutput: "M\tscripts/a.mjs\n" }, // no diffOutput
        repo: "owner/repo",
        pr: 21,
        headSha: "abc1234567890",
      },
      { repoRoot },
    );
    assert.equal(result.artifact.scope.diffPath, null);
    assert.deepEqual(result.artifact.scope.changedFiles, ["scripts/a.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildGateContext — neutral adjacent-code bundle (#895)
// ---------------------------------------------------------------------------

test("buildGateContext attaches a deterministic adjacentCode bundle (imports + importers of the changed file)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    // Build a small repo: changed.mjs imports dep.mjs; caller.mjs imports changed.mjs.
    const files = {
      "src/changed.mjs": 'import { helper } from "./dep.mjs";\nexport function changed() { return helper(); }\n',
      "src/dep.mjs": "export function helper() { return 1; }\n",
      "src/caller.mjs": 'import { changed } from "./changed.mjs";\nchanged();\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repoRoot, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }

    const config = draftConfig({ dynamicAngles: false });
    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff: {
          nameStatusOutput: "M\tsrc/changed.mjs\n",
          diffOutput: "diff --git a/src/changed.mjs b/src/changed.mjs\n+changed\n",
        },
        repo: "owner/repo",
        pr: 30,
        headSha: "abc1234567890",
      },
      { repoRoot },
    );

    const bundle = result.artifact.adjacentCode;
    assert.ok(bundle, "adjacentCode bundle attached");
    const byPath = Object.fromEntries(bundle.files.map((f) => [f.path, f]));
    assert.equal(byPath["src/changed.mjs"].role, "changed");
    assert.equal(byPath["src/dep.mjs"].role, "imports"); // out-edge
    assert.equal(byPath["src/caller.mjs"].role, "importedBy"); // in-edge

    // Deterministic: a second build produces an identical bundle.
    const result2 = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        diff: {
          nameStatusOutput: "M\tsrc/changed.mjs\n",
          diffOutput: "diff --git a/src/changed.mjs b/src/changed.mjs\n+changed\n",
        },
        repo: "owner/repo",
        pr: 30,
        headSha: "abc1234567890",
      },
      { repoRoot },
    );
    assert.equal(JSON.stringify(result2.artifact.adjacentCode), JSON.stringify(bundle));

    // Round-trips on disk.
    const onDisk = await readGateContext({
      repo: "owner/repo", pr: 30, gate: "draft_gate", headSha: "abc1234567890",
    }, { repoRoot });
    assert.ok(onDisk.adjacentCode);
    assert.deepEqual(
      onDisk.adjacentCode.files.map((f) => f.path).sort(),
      ["src/caller.mjs", "src/changed.mjs", "src/dep.mjs"],
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildGateContext omits adjacentCode when there are no changed files (backward-compatible shape)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig();
    const result = await buildGateContext(
      { config, gate: "draft_gate", repo: "owner/repo", pr: 31, headSha: "abc1234567890" },
      { repoRoot },
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result.artifact, "adjacentCode"), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildGateContext leaves scope.diffPath null and changedFiles empty when no diff is given", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-context-"));
  try {
    const config = draftConfig();
    const result = await buildGateContext(
      {
        config,
        gate: "draft_gate",
        repo: "owner/repo",
        pr: 22,
        headSha: "abc1234567890",
      },
      { repoRoot },
    );
    assert.equal(result.artifact.scope.diffPath, null);
    assert.deepEqual(result.artifact.scope.changedFiles, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
