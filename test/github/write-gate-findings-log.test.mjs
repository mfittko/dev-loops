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
        { severity: "defer", angle: "naming", summary: "Style", disposition: "disputed" },
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
        provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "dry", reviewer: "r1" }, { angle: "pr-checklist-matrix" }, { angle: "made-up-angle" }] }),
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
