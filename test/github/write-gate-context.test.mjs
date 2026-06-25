import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveGateAnglesDynamic } from "@dev-loops/core/config";

import {
  buildGateContext,
  buildGateContextArtifact,
  buildGateContextPath,
  mapGateToConfigKey,
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
  });
  assert.deepEqual(resolvedAngles, ["gate-evidence", "docs"]);
  assert.deepEqual(rationale.find((r) => r.angle === "gate-evidence"), {
    angle: "gate-evidence", action: "kept", reason: "selected by dynamic angle resolver",
  });
  assert.deepEqual(rationale.find((r) => r.angle === "coverage"), {
    angle: "coverage", action: "dropped", reason: "DOCS_ONLY",
  });
});

test("rationaleFromResolver tolerates null/empty resolver output", () => {
  const { resolvedAngles, rationale } = rationaleFromResolver({ recommendedAngles: null });
  assert.deepEqual(resolvedAngles, []);
  assert.deepEqual(rationale, []);
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

    // Scope persisted.
    assert.deepEqual(result.artifact.scope, {
      branch: "issue-877",
      headSha: "abc1234567890",
      touchedFiles: ["docs/foo.md", "README.md"],
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
