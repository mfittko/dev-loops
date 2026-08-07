import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkProvenanceAngleCoverage,
  parseProvenanceJson,
  parseWriteGateFindingsLogCliArgs,
  writeGateFindingsLog,
} from "../../scripts/github/write-gate-findings-log.mjs";

// A repo config with a fully controlled, minimal angle contract (independent
// of the shipped extension defaults) so mandatory-angle / pool assertions
// below are exact.
const ANGLE_CONTRACT_DEVLOOPS = [
  "version: 1",
  "gates:",
  "  draft:",
  "    angles:",
  "      - scope",
  "      - coverage",
  "      - name: pr-description",
  "        mandatory: true",
  "  preApproval:",
  "    angles:",
  "      - dry",
  "      - kiss",
  "      - name: pr-checklist-matrix",
  "        mandatory: true",
  "",
].join("\n");

async function withAngleContractRepo(fn, { rejectForeignAngles } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-angle-contract-"));
  try {
    const devloops = rejectForeignAngles === false
      ? `${ANGLE_CONTRACT_DEVLOOPS}  rejectForeignAngles: false\n`
      : ANGLE_CONTRACT_DEVLOOPS;
    await writeFile(path.join(repoRoot, ".devloops"), devloops, "utf8");
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("parseWriteGateFindingsLogCliArgs parses all required args", () => {
  const result = parseWriteGateFindingsLogCliArgs([
    "--repo", "owner/repo",
    "--pr", "42",
    "--gate", "draft_gate",
    "--head-sha", "abc1234567890abcdef000000000000000000000",
    "--verdict", "findings_present",
    "--findings", '[{"severity":"must-fix","angle":"scope","summary":"bad scope"}]',
  ]);
  assert.deepEqual(result, {
    repo: "owner/repo",
    pr: 42,
    gate: "draft_gate",
    headSha: "abc1234567890abcdef000000000000000000000",
    verdict: "findings_present",
    findings: '[{"severity":"must-fix","angle":"scope","summary":"bad scope"}]',
    findingsFile: undefined,
    fullLabel: false,
    tmpRoot: "tmp",
  });
});

test("parseWriteGateFindingsLogCliArgs accepts custom tmp-root", () => {
  const result = parseWriteGateFindingsLogCliArgs([
    "--repo", "owner/repo",
    "--pr", "1",
    "--gate", "pre_approval_gate",
    "--head-sha", "deadbeef12345678900000000000000000000000",
    "--verdict", "clean",
    "--findings", "[]",
    "--tmp-root", "custom-tmp",
  ]);
  assert.equal(result.tmpRoot, "custom-tmp");
});

test("parseWriteGateFindingsLogCliArgs rejects invalid gate", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "bad_gate",
      "--head-sha", "abc1234500000000000000000000000000000000", "--verdict", "clean", "--findings", "[]",
    ]);
  }, /gate/);
});

test("parseWriteGateFindingsLogCliArgs rejects invalid verdict", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc1234500000000000000000000000000000000", "--verdict", "invalid", "--findings", "[]",
    ]);
  }, /verdict/);
});

test("parseWriteGateFindingsLogCliArgs rejects invalid head SHA", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "short", "--verdict", "clean", "--findings", "[]",
    ]);
  }, /hex/);
});

test("writeGateFindingsLog rejects non-array findings JSON", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: '{"not":"array"}',
    });
  }, /array/);
});

test("parseWriteGateFindingsLogCliArgs rejects missing required args", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b",
      "--pr", "1",
    ]);
  }, /Missing required/);
});

test("parseWriteGateFindingsLogCliArgs accepts --findings-file", () => {
  const result = parseWriteGateFindingsLogCliArgs([
    "--repo", "owner/repo",
    "--pr", "42",
    "--gate", "draft_gate",
    "--head-sha", "abc1234567890abcdef000000000000000000000",
    "--verdict", "clean",
    "--findings-file", "/tmp/findings.json",
  ]);
  assert.equal(result.findingsFile, "/tmp/findings.json");
  assert.equal(result.findings, undefined);
});

test("parseWriteGateFindingsLogCliArgs rejects --findings and --findings-file together", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc1234500000000000000000000000000000000", "--verdict", "clean",
      "--findings", "[]", "--findings-file", "/tmp/findings.json",
    ]);
  }, /mutually exclusive/);
});

test("parseWriteGateFindingsLogCliArgs rejects when neither --findings nor --findings-file is given", () => {
  assert.throws(() => {
    parseWriteGateFindingsLogCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc1234500000000000000000000000000000000", "--verdict", "clean",
    ]);
  }, /pass --findings <json> or --findings-file <path>/);
});

test("writeGateFindingsLog writes valid JSON log", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 42,
      gate: "draft_gate",
      headSha: "abc1234567890abcdef000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "scope", summary: "Scope too broad", disposition: "accepted-for-fix", files: ["src/a.mjs"] },
        { severity: "worth-fixing-now", angle: "dry", summary: "DRY violation", disposition: "deferred" },
      ]),
      tmpRoot: tmpDir,
    });

    assert.equal(result.ok, true);
    assert.ok(result.path.includes("draft_gate-abc1234567890abcdef000000000000000000000.json"));

    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-42", "draft_gate-abc1234567890abcdef000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.repo, "owner/repo");
    assert.equal(parsed.pr, 42);
    assert.equal(parsed.gate, "draft_gate");
    assert.equal(parsed.headSha, "abc1234567890abcdef000000000000000000000");
    assert.equal(parsed.verdict, "findings_present");
    assert.ok(parsed.loggedAt);
    assert.equal(parsed.findings.length, 2);
    assert.equal(parsed.findings[0].severity, "must-fix");
    assert.equal(parsed.findings[0].angle, "scope");
    assert.deepEqual(parsed.findings[0].files, ["src/a.mjs"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog handles empty findings array", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 1,
      gate: "pre_approval_gate",
      headSha: "deadbeef12345678900000000000000000000000",
      verdict: "clean",
      findings: "[]",
      tmpRoot: tmpDir,
    });

    assert.equal(result.ok, true);
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-1", "pre_approval_gate-deadbeef12345678900000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.findings.length, 0);
    assert.equal(parsed.verdict, "clean");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog rejects invalid severity", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "bad-sev", angle: "scope", summary: "x" }]),
    });
  }, /severity/);
});

test("writeGateFindingsLog rejects finding without angle", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", summary: "x" }]),
    });
  }, /angle/);
});

test("writeGateFindingsLog rejects finding without summary", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope" }]),
    });
  }, /summary/);
});

test("writeGateFindingsLog includes disposition when present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 99,
      gate: "pre_approval_gate",
      headSha: "ccccccccccccccccc00000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "scope", summary: "Must fix", disposition: "accepted-for-fix" },
        { severity: "worth-fixing-now", angle: "dry", summary: "DRY", disposition: "deferred" },
        { severity: "nice-to-have", angle: "naming", summary: "Style", disposition: "disputed" },
      ]),
      tmpRoot: tmpDir,
    });

    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-99", "pre_approval_gate-ccccccccccccccccc00000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.findings[0].disposition, "accepted-for-fix");
    assert.equal(parsed.findings[1].disposition, "deferred");
    assert.equal(parsed.findings[2].disposition, "disputed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog rejects invalid disposition", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", disposition: "bad" }]),
    });
  }, /disposition/);
});

test("writeGateFindingsLog rejects malformed repo format in buildLogPath", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "no-slash",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
    });
  }, /owner\/name format/);
});

test("writeGateFindingsLog includes resolvedIn when present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 99,
      gate: "pre_approval_gate",
      headSha: "ccccccccccccccccc00000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "scope", summary: "Fixed", resolvedIn: "bbbbbbbbbbbbbbb" },
      ]),
      tmpRoot: tmpDir,
    });

    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-99", "pre_approval_gate-ccccccccccccccccc00000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.findings[0].resolvedIn, "bbbbbbbbbbbbbbb");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog accepts operator_acknowledged disposition", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 99,
      gate: "pre_approval_gate",
      headSha: "dddddddddddddddd000000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "scope", summary: "Ack", disposition: "operator_acknowledged" },
      ]),
      tmpRoot: tmpDir,
    });

    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-99", "pre_approval_gate-dddddddddddddddd000000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.findings[0].disposition, "operator_acknowledged");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
test("writeGateFindingsLog rejects invalid resolvedIn (not a hex SHA)", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", resolvedIn: "not-a-sha" }]),
    });
  }, /resolvedIn must be a 7-64 char hex SHA/);
});

test("writeGateFindingsLog rejects repo with dot segment", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "./repo",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
    });
  }, /unsafe characters/);
});

test("writeGateFindingsLog rejects repo with double-dot segment", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "owner/..",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
    });
  }, /unsafe characters/);
});

test("writeGateFindingsLog rejects repo with whitespace in segment", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "owner/repo name",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
    });
  }, /unsafe characters/);
});

test("writeGateFindingsLog rejects repo with backslash in segment", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "owner/re\\po",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
    });
  }, /unsafe characters/);
});

test("writeGateFindingsLog rejects empty-string disposition", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", disposition: "" }]),
    });
  }, /disposition must be a non-empty string/);
});

test("writeGateFindingsLog rejects empty-string resolvedIn", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", resolvedIn: "" }]),
    });
  }, /resolvedIn must be a non-empty string/);
});

test("writeGateFindingsLog includes an optional positive-integer line when present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 99,
      gate: "pre_approval_gate",
      headSha: "eeeeeeeeeeeeeeeeee0000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "scope", summary: "Off by one", line: 42 },
      ]),
      tmpRoot: tmpDir,
    });

    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-99", "pre_approval_gate-eeeeeeeeeeeeeeeeee0000000000000000000000.json");
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.findings[0].line, 42);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog rejects a non-integer line", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", line: 1.5 }]),
    });
  }, /line must be a positive integer/);
});

test("writeGateFindingsLog rejects a zero line", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", line: 0 }]),
    });
  }, /line must be a positive integer/);
});

test("writeGateFindingsLog rejects a negative line", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "must-fix", angle: "scope", summary: "x", line: -1 }]),
    });
  }, /line must be a positive integer/);
});

// --- --findings-file (mutually exclusive with --findings, identical validation) ---

test("writeGateFindingsLog accepts findings from --findings-file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-file-"));
  try {
    const findingsFile = path.join(tmpDir, "findings.json");
    await writeFile(findingsFile, JSON.stringify([
      { severity: "must-fix", angle: "scope", summary: "bad scope", disposition: "accepted-for-fix" },
    ]), "utf8");
    const result = await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234567890abcdef000000000000000000000",
      verdict: "findings_present",
      findingsFile,
      tmpRoot: tmpDir,
    });
    assert.equal(result.ok, true);
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-1", "draft_gate-abc1234567890abcdef000000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].angle, "scope");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog rejects both --findings and --findings-file", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
      findingsFile: "/tmp/does-not-matter.json",
    });
  }, /mutually exclusive/);
});

test("writeGateFindingsLog rejects a missing --findings-file", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findingsFile: "/nonexistent/gate-findings-file-does-not-exist.json",
    });
  }, /Cannot read --findings-file/);
});

test("writeGateFindingsLog derives a deferred disposition for a nice-to-have finding with no explicit disposition", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-defer-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 5,
      gate: "draft_gate",
      headSha: "eeeeeeeeeeeeeeeeeeee00000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "nice-to-have", angle: "naming", summary: "Style nit" }]),
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-5", "draft_gate-eeeeeeeeeeeeeeeeeeee00000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings[0].disposition, "deferred");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog keeps an explicit disposition on a nice-to-have finding (still validated against the enum)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-defer-explicit-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 6,
      gate: "draft_gate",
      headSha: "ffffffffffffffffffff0000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "nice-to-have", angle: "naming", summary: "Style nit", disposition: "disputed" }]),
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-6", "draft_gate-ffffffffffffffffffff0000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings[0].disposition, "disputed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "nice-to-have", angle: "naming", summary: "Style nit", disposition: "bad-value" }]),
    });
  }, /disposition must be one of/);
});

// --- Fan-out provenance (AC1) ---

test("parseProvenanceJson accepts a well-formed provenance object", () => {
  const prov = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 2,
    perAngle: [
      { angle: "scope", reviewer: "review-a", dispatchId: "d1", model: "m1" },
      { angle: "safety", reviewer: "review-b" },
    ],
  }));
  assert.equal(prov.distinctReviewers, 2);
  assert.equal(prov.perAngle.length, 2);
  assert.deepEqual(prov.perAngle[0], { angle: "scope", reviewer: "review-a", dispatchId: "d1", model: "m1" });
  assert.deepEqual(prov.perAngle[1], { angle: "safety", reviewer: "review-b" });
});

test("parseProvenanceJson accepts and normalizes a carried-forward angle (carriedFromHead)", () => {
  const prov = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 1,
    perAngle: [
      { angle: "correctness", reviewer: "review-a", carriedFromHead: "ABC1234" },
    ],
  }));
  assert.deepEqual(prov.perAngle[0], { angle: "correctness", reviewer: "review-a", carriedFromHead: "abc1234" });
});

test("parseProvenanceJson rejects a malformed carriedFromHead (not a hex SHA)", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "correctness", reviewer: "review-a", carriedFromHead: "zzz" }] })),
    /carriedFromHead must be a 7-64 char hex SHA/,
  );
});

test("parseProvenanceJson rejects malformed provenance (invalid JSON, non-object, bad shape)", () => {
  assert.throws(() => parseProvenanceJson("{not json"), /must be valid JSON/);
  assert.throws(() => parseProvenanceJson("[]"), /must be a JSON object/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ perAngle: [] })), /distinctReviewers must be a non-negative integer/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ distinctReviewers: 1.5, perAngle: [] })), /distinctReviewers must be a non-negative integer/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2 })), /perAngle must be an array/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2, perAngle: [{}] })), /perAngle\[0\]\.angle is required/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "" }] })), /reviewer must be a non-empty string/);
  assert.throws(() => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2, perAngle: [null] })), /perAngle\[0\] must be an object/);
});

test("parseProvenanceJson rejects INTERNALLY-INCONSISTENT provenance (closes the {n, perAngle:[]} loophole)", () => {
  // The crux loophole: claim N reviewers with zero dispatch records.
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2, perAngle: [] })),
    /perAngle must be non-empty when distinctReviewers > 0/,
  );
  // Claim more reviewers than distinct recorded identities.
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({ distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "review-a" }] })),
    /distinctReviewers \(2\) exceeds distinct recorded reviewer identities \(1\)/,
  );
  // A perAngle entry with no reviewer/dispatchId is not a countable reviewer.
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "scope" }] })),
    /distinctReviewers \(1\) exceeds distinct recorded reviewer identities \(0\)/,
  );
  // dispatchId also counts as an identity; two distinct dispatchIds satisfy 2.
  const ok = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 2,
    perAngle: [{ angle: "scope", dispatchId: "d1" }, { angle: "safety", dispatchId: "d2" }],
  }));
  assert.equal(ok.distinctReviewers, 2);
});

// --- One-scoped-reviewer-per-fresh-angle floor (always-on write-time, #1431) ---

test("parseProvenanceJson rejects one reviewer covering two fresh angles (under-provisioned ledger)", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 1,
      perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-a" }],
    })),
    /--provenance\.perAngle fan-out provenance violates the one-scoped-reviewer-per-angle contract/,
  );
});

test("parseProvenanceJson accepts one distinct reviewer per fresh angle", () => {
  const prov = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 2,
    perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }],
  }));
  assert.equal(prov.distinctReviewers, 2);
});

test("parseProvenanceJson exempts a carried angle from the pairing floor (same reviewer as a fresh angle is not a collision)", () => {
  const prov = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 1,
    perAngle: [
      { angle: "scope", reviewer: "review-a" },
      { angle: "safety", reviewer: "review-a", carriedFromHead: "abc1234" },
    ],
  }));
  assert.equal(prov.perAngle.length, 2);
});

// --- Grouped fan-out dispatch provenance (AC7) ---

test("parseProvenanceJson accepts two fresh angles sharing a reviewer under the SAME declared group", () => {
  const prov = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 1,
    perAngle: [
      { angle: "docs", reviewer: "review-a", group: "docs-surface" },
      { angle: "link-check", reviewer: "review-a", group: "docs-surface" },
    ],
  }));
  assert.equal(prov.perAngle.length, 2);
  assert.equal(prov.perAngle[0].group, "docs-surface");
});

test("parseProvenanceJson rejects two fresh angles sharing a reviewer under DIFFERENT declared groups", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 1,
      perAngle: [
        { angle: "docs", reviewer: "review-a", group: "docs-surface" },
        { angle: "scope", reviewer: "review-a", group: "process" },
      ],
    })),
    /--provenance\.perAngle fan-out provenance violates the one-scoped-reviewer-per-angle contract/,
  );
});

test("parseProvenanceJson rejects two fresh angles sharing a reviewer where only one entry declares a group", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 1,
      perAngle: [
        { angle: "docs", reviewer: "review-a", group: "docs-surface" },
        { angle: "link-check", reviewer: "review-a" },
      ],
    })),
    /--provenance\.perAngle fan-out provenance violates the one-scoped-reviewer-per-angle contract/,
  );
});

test("parseProvenanceJson still rejects a shared reviewer across two fresh angles with no group at all (legacy shape unchanged)", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 1,
      perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-a" }],
    })),
    /--provenance\.perAngle fan-out provenance violates the one-scoped-reviewer-per-angle contract/,
  );
});

test("parseProvenanceJson rejects a non-string group value", () => {
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 1,
      perAngle: [{ angle: "docs", reviewer: "review-a", group: 1 }],
    })),
    /perAngle\[0\]\.group must be a non-empty string/,
  );
});

test("writeGateFindingsLog rejects a 2-fresh-angle/1-reviewer ledger (write-time floor, always-on)", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
      provenance: JSON.stringify({
        distinctReviewers: 1,
        perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "coverage", reviewer: "review-a" }],
      }),
    });
  }, /one-scoped-reviewer-per-angle contract/);
});

test("writeGateFindingsLog accepts a one-reviewer-per-fresh-angle ledger", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-pairing-"));
    try {
      const result = await writeGateFindingsLog({
        repo: "a/b",
        pr: 1,
        gate: "pre_approval_gate",
        headSha: "abc1234500000000000000000000000000000000",
        verdict: "clean",
        findings: "[]",
        provenance: JSON.stringify({
          distinctReviewers: 2,
          perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "pr-checklist-matrix", reviewer: "review-b" }],
        }),
        tmpRoot: tmpDir,
      }, { repoRoot });
      assert.equal(result.ok, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("writeGateFindingsLog accepts a grouped-dispatch ledger where one reviewer covers its whole declared group (AC7)", async () => {
  // A dedicated fixture (not the shared ANGLE_CONTRACT_DEVLOOPS one, which
  // carries no gates.fanout override and so inherits the shipped default
  // grouping table — under which "dry" and "pr-checklist-matrix" are NOT
  // configured together): the write path now cross-checks a claimed `group`
  // against gates.fanout.groups, so the fixture must actually configure
  // dry + pr-checklist-matrix into the same group for this to be a genuinely
  // legitimate grouped-dispatch scenario.
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-angle-contract-grouped-"));
  try {
    await writeFile(
      path.join(repoRoot, ".devloops"),
      [
        "version: 1",
        "gates:",
        "  preApproval:",
        "    angles:",
        "      - dry",
        "      - kiss",
        "      - name: pr-checklist-matrix",
        "        mandatory: true",
        "  fanout:",
        "    groups:",
        "      - name: process",
        "        angles: [dry, pr-checklist-matrix]",
        "",
      ].join("\n"),
      "utf8",
    );
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-grouped-"));
    try {
      const result = await writeGateFindingsLog({
        repo: "a/b",
        pr: 1,
        gate: "pre_approval_gate",
        headSha: "abc1234500000000000000000000000000000000",
        verdict: "clean",
        findings: "[]",
        provenance: JSON.stringify({
          distinctReviewers: 1,
          perAngle: [
            { angle: "dry", reviewer: "review-a", group: "process" },
            { angle: "pr-checklist-matrix", reviewer: "review-a", group: "process" },
          ],
        }),
        tmpRoot: tmpDir,
      }, { repoRoot });
      assert.equal(result.ok, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog accepts a grouped-provenance ledger under --full-label (gate:full dispatches grouped per ADR 0048, #1601)", async () => {
  // Same fixture + provenance as the "accepts a grouped-dispatch ledger" test
  // above, EXCEPT fullLabel: true is threaded through. As of #1601 (ADR 0048)
  // gate:full no longer restores per-angle dispatch — it forces the full angle
  // set upstream and dispatches GROUPED, so the configured "process" group
  // still resolves and the SAME provenance a tiered round accepts is also
  // accepted on a gate:full round (the write path resolves the SAME grouping
  // the read/enforcement path resolves for gate:full).
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-full-label-grouped-"));
  try {
    await writeFile(
      path.join(repoRoot, ".devloops"),
      [
        "version: 1",
        "gates:",
        "  preApproval:",
        "    angles:",
        "      - dry",
        "      - kiss",
        "      - name: pr-checklist-matrix",
        "        mandatory: true",
        "  fanout:",
        "    groups:",
        "      - name: process",
        "        angles: [dry, pr-checklist-matrix]",
        "",
      ].join("\n"),
      "utf8",
    );
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-full-label-grouped-out-"));
    try {
      const result = await writeGateFindingsLog({
        repo: "a/b",
        pr: 1,
        gate: "pre_approval_gate",
        headSha: "abc1234500000000000000000000000000000000",
        verdict: "clean",
        findings: "[]",
        provenance: JSON.stringify({
          distinctReviewers: 1,
          perAngle: [
            { angle: "dry", reviewer: "review-a", group: "process" },
            { angle: "pr-checklist-matrix", reviewer: "review-a", group: "process" },
          ],
        }),
        fullLabel: true,
        tmpRoot: tmpDir,
      }, { repoRoot });
      assert.equal(result.ok, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
test("writeGateFindingsLog rejects a grouped-dispatch ledger whose declared group the configured gates.fanout.groups table does not actually place together (fabricated group label)", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-grouped-fabricated-"));
    try {
      await assert.rejects(
        () => writeGateFindingsLog({
          repo: "a/b",
          pr: 1,
          gate: "pre_approval_gate",
          headSha: "abc1234500000000000000000000000000000000",
          verdict: "clean",
          findings: "[]",
          // "dry" and "pr-checklist-matrix" are never grouped together by the
          // config this fixture inherits (the shipped default "process" group
          // covers scope/pr-description/gate-evidence/pr-checklist-matrix, not
          // "dry") — a self-attested shared "group" label alone must not pass.
          provenance: JSON.stringify({
            distinctReviewers: 1,
            perAngle: [
              { angle: "dry", reviewer: "review-a", group: "process" },
              { angle: "pr-checklist-matrix", reviewer: "review-a", group: "process" },
            ],
          }),
          tmpRoot: tmpDir,
        }, { repoRoot }),
        /does not place all of them in one group/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("writeGateFindingsLog accepts a carried-angle ledger that reuses the prior head's reviewer for a fresh angle", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-carried-"));
    try {
      const result = await writeGateFindingsLog({
        repo: "a/b",
        pr: 1,
        gate: "pre_approval_gate",
        // Full 40-hex primary head SHA (current contract); carriedFromHead may
        // stay a short 7-64 hex prefix.
        headSha: "abc1234500000000000000000000000000000000",
        verdict: "clean",
        findings: "[]",
        provenance: JSON.stringify({
          distinctReviewers: 1,
          perAngle: [
            { angle: "pr-checklist-matrix", reviewer: "review-a" },
            { angle: "dry", reviewer: "review-a", carriedFromHead: "abc1234" },
          ],
        }),
        tmpRoot: tmpDir,
      }, { repoRoot });
      assert.equal(result.ok, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("writeGateFindingsLog records provenance in the ledger when passed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 7,
      gate: "pre_approval_gate",
      headSha: "abc1234567890abcdef000000000000000000000",
      verdict: "clean",
      findings: "[]",
      // Angles must cover the shipped extension-defaults preApproval mandatory
      // angle (pr-checklist-matrix) and stay within its configured pool — this
      // test isolates repoRoot from any repo-local .devloops via tmpDir, but
      // the packaged extension defaults still apply regardless of repoRoot.
      provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
      tmpRoot: tmpDir,
    }, { repoRoot: tmpDir });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-7", "pre_approval_gate-abc1234567890abcdef000000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.provenance.distinctReviewers, 3);
    assert.equal(parsed.provenance.perAngle.length, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog omits provenance key entirely when absent (byte-identical to before)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-test-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 8,
      gate: "draft_gate",
      headSha: "abc1234567890abcdef000000000000000000000",
      verdict: "clean",
      findings: "[]",
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-8", "draft_gate-abc1234567890abcdef000000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal("provenance" in parsed, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog rejects malformed provenance", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: "[]",
      provenance: JSON.stringify({ distinctReviewers: -1, perAngle: [] }),
    });
  }, /distinctReviewers must be a non-negative integer/);
});

// --- Angle-coverage enforcement (#1196: mandatory angles + pool membership) ---

test("checkProvenanceAngleCoverage rejects a missing mandatory angle (fail-closed, AC1)", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    await assert.rejects(
      () => checkProvenanceAngleCoverage({ perAngle: [{ angle: "dry" }] }, "pre_approval_gate", { repoRoot }),
      /missing mandatory angle\(s\) for pre_approval_gate: pr-checklist-matrix/,
    );
  });
});

test("writeGateFindingsLog rejects a fanout_fanin ledger missing a mandatory angle (AC1, write time)", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "a/b", pr: 1, gate: "draft_gate", headSha: "abc1234500000000000000000000000000000000", verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "scope", reviewer: "r1" }] }),
      }, { repoRoot }),
      /missing mandatory angle\(s\) for draft_gate: pr-description/,
    );
  });
});

test("checkProvenanceAngleCoverage rejects an angle outside the configured pool by default (AC2)", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    await assert.rejects(
      () => checkProvenanceAngleCoverage(
        { perAngle: [{ angle: "dry" }, { angle: "pr-checklist-matrix" }, { angle: "made-up-angle" }] },
        "pre_approval_gate",
        { repoRoot },
      ),
      /names angle\(s\) outside the configured pool for pre_approval_gate: made-up-angle/,
    );
  });
});

test("checkProvenanceAngleCoverage accepts the fan-in synthetic pr-checklist-matrix angle when the gate's pool omits it (#1494)", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    // draft's configured pool (scope, coverage, pr-description) does not list
    // pr-checklist-matrix; the fan-in-synthetic exemption must let it through
    // without a warning.
    const result = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "scope", reviewer: "r1" }, { angle: "pr-description", reviewer: "r2" }, { angle: "pr-checklist-matrix", reviewer: "r3" }] },
      "draft_gate",
      { repoRoot },
    );
    assert.equal(result.warning ?? null, null);
  });
});

test("checkProvenanceAngleCoverage warns (does not fail) on a foreign angle when gates.rejectForeignAngles is false", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const result = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "dry" }, { angle: "pr-checklist-matrix" }, { angle: "made-up-angle" }] },
      "pre_approval_gate",
      { repoRoot },
    );
    assert.match(result.warning, /made-up-angle/);
  }, { rejectForeignAngles: false });
});

test("writeGateFindingsLog surfaces the foreign-angle warning on the result when rejectForeignAngles is false", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-warn-"));
    try {
      const result = await writeGateFindingsLog({
        repo: "a/b", pr: 1, gate: "pre_approval_gate", headSha: "abc1234500000000000000000000000000000000", verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "r1" }, { angle: "pr-checklist-matrix", reviewer: "r2" }, { angle: "made-up-angle", reviewer: "r3" }] }),
        tmpRoot,
      }, { repoRoot });
      assert.equal(result.ok, true);
      assert.match(result.warning, /made-up-angle/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, { rejectForeignAngles: false });
});

test("checkProvenanceAngleCoverage: a delta-suffixed angle (<angle>-delta-at-current-head) satisfies its base mandatory angle", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const result = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "dry" }, { angle: "pr-checklist-matrix-delta-at-current-head" }] },
      "pre_approval_gate",
      { repoRoot },
    );
    assert.equal(result.warning, null);
  });
});

test("checkProvenanceAngleCoverage passes for a fully-covered draft_gate and pre_approval_gate shape", async () => {
  await withAngleContractRepo(async (repoRoot) => {
    const draft = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "scope" }, { angle: "pr-description" }] },
      "draft_gate",
      { repoRoot },
    );
    assert.equal(draft.warning, null);
    const preApproval = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "dry" }, { angle: "kiss" }, { angle: "pr-checklist-matrix" }] },
      "pre_approval_gate",
      { repoRoot },
    );
    assert.equal(preApproval.warning, null);
  });
});

test("checkProvenanceAngleCoverage: excluding a mandatory angle does not deadlock the write (excludeAngles filters mandatoryAngles)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-exclude-deadlock-"));
  try {
    // The deadlock config: yagni is mandatory AND excluded. Without filtering,
    // every write would fail — missing-mandatory if omitted, foreign if recorded.
    await writeFile(path.join(repoRoot, ".devloops"), [
      "version: 1",
      "gates:",
      "  preApproval:",
      "    angles: [dry, kiss]",
      "    mandatoryAngles: [pr-checklist-matrix, yagni]",
      "    excludeAngles: [yagni]",
      "",
    ].join("\n"), "utf8");
    const result = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "dry" }, { angle: "pr-checklist-matrix" }] },
      "pre_approval_gate",
      { repoRoot },
    );
    assert.equal(result.warning, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("checkProvenanceAngleCoverage: additiveAngles widens the enforcement pool to the catalog (catalog angle is not foreign)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-additive-"));
  try {
    await writeFile(path.join(repoRoot, ".devloops"), [
      "version: 1",
      "gates:",
      "  anglePool: [dry, catalog-extra]",
      "  preApproval:",
      "    angles:",
      "      - dry",
      // The shipped extension-defaults.yaml also configures preApproval with a
      // mandatory pr-checklist-matrix angle, merged by name (D3) — disable it
      // here so this test's minimal contract (dry + the additive catalog) is
      // the whole mandatory-angle picture.
      "      - name: pr-checklist-matrix",
      "        enabled: false",
      "    dynamic:",
      "      additive: true",
      "",
    ].join("\n"), "utf8");
    const result = await checkProvenanceAngleCoverage(
      { perAngle: [{ angle: "dry" }, { angle: "catalog-extra" }] },
      "pre_approval_gate",
      { repoRoot },
    );
    assert.equal(result.warning, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("a legacy defer-severity finding normalizes to nice-to-have in the written log", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-legacy-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: "findings_present",
      findings: JSON.stringify([{ severity: "defer", angle: "docs", summary: "legacy entry" }]),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.findings[0].severity, "nice-to-have");
    assert.equal(parsed.findings[0].disposition, "deferred");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
