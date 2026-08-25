import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLogPath,
  checkProvenanceAngleCoverage,
  parseProvenanceJson,
  parseWriteGateFindingsLogCliArgs,
  writeGateFindingsLog,
} from "../../scripts/github/write-gate-findings-log.mjs";
import { runNode as runNodeHelper } from "../_helpers.mjs";

const writeGateFindingsLogScript = path.resolve("scripts/github/write-gate-findings-log.mjs");

// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
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

test("writeGateFindingsLog fails closed on a malformed fingerprint shape", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([{ severity: "low", angle: "scope", summary: "x", fingerprint: "not-16-hex" }]),
    });
  }, /fingerprint must be a 16-char lowercase hex string/);
});

test("writeGateFindingsLog accepts a valid 16-hex fingerprint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wgfl-fp-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([{ severity: "low", angle: "scope", summary: "x", fingerprint: "0123456789abcdef" }]),
      tmpRoot: dir,
    });
    const written = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(written.findings[0].fingerprint, "0123456789abcdef");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.equal(parsed.findings[0].severity, "high"); // "must-fix" input normalizes to canonical "high"
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

test("writeGateFindingsLog rejects a followUpDraft with an empty title", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { title: "", body: "b" } },
      ]),
    });
  }, /\[0\]\.followUpDraft must have a non-empty title and a body string/);
});

test("writeGateFindingsLog rejects a followUpDraft with a non-string body", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { title: "t", body: 42 } },
      ]),
    });
  }, /\[0\]\.followUpDraft must have a non-empty title and a body string/);
});

test("writeGateFindingsLog rejects a followUpDraft with a missing title", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { body: "b" } },
      ]),
    });
  }, /\[0\]\.followUpDraft must have a non-empty title and a body string/);
});

test("writeGateFindingsLog rejects a non-object (string) followUpDraft instead of silently dropping it", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: "see the follow-up" },
      ]),
    });
  }, /\[0\]\.followUpDraft must be an object/);
});

test("writeGateFindingsLog rejects an array-wrapped followUpDraft instead of silently dropping it", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: ["t", "b"] },
      ]),
    });
  }, /\[0\]\.followUpDraft must be an object/);
});

test("writeGateFindingsLog rejects a whitespace-only followUpDraft title", async () => {
  await assert.rejects(async () => {
    await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { title: "   ", body: "b" } },
      ]),
    });
  }, /\[0\]\.followUpDraft must have a non-empty title and a body string/);
});

test("writeGateFindingsLog stores a padded followUpDraft title raw (validated trimmed, stored untrimmed)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-followup-raw-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { title: "  ok  ", body: "" } },
      ]),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.deepEqual(parsed.findings[0].followUpDraft, { title: "  ok  ", body: "" });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeGateFindingsLog passes a well-formed followUpDraft through unchanged", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-followup-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "a/b",
      pr: 1,
      gate: "draft_gate",
      headSha: "abc1234500000000000000000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([
        { severity: "low", angle: "docs", summary: "x", followUpDraft: { title: "t", body: "b" } },
      ]),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.deepEqual(parsed.findings[0].followUpDraft, { title: "t", body: "b" });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

// #1592: a LOCATABLE question (real file + positive-integer line) is
// answered, never deferred — it gets its own disposition ("needs-answer"),
// because it gets a resolvable review thread to answer through.
test("writeGateFindingsLog derives a needs-answer disposition for a LOCATABLE question finding with no explicit disposition", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-question-locatable-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 7,
      gate: "draft_gate",
      headSha: "1111111111111111111100000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "question", angle: "scope", summary: "Why this approach?", files: ["src/a.mjs"], line: 12 }]),
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-7", "draft_gate-1111111111111111111100000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings[0].disposition, "needs-answer");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// A NON-LOCATABLE question (no file/line) has no resolvable thread to answer
// through — it is deferred by construction, exactly like every other
// non-blocking severity's default.
test("writeGateFindingsLog derives a deferred disposition for a NON-LOCATABLE question finding with no explicit disposition", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-question-nonlocatable-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 7,
      gate: "draft_gate",
      headSha: "2222222222222222222200000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "question", angle: "scope", summary: "Why this approach?" }]),
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-7", "draft_gate-2222222222222222222200000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings[0].disposition, "deferred");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// Copilot review (PR #1610): files[] entries were filtered for emptiness but
// stored UNTRIMMED — a padded path (" src/a.mjs ") still counted as
// locatable-SHAPED (deriving "needs-answer"), but every downstream consumer
// that keys on the raw stored value (the diff's commentable-line lookup, the
// posted review `path`, renderNonLocatableBlock's Location line) compares
// against the TRIMMED form, so it would never actually match a real in-diff
// position — locatability and disposition must agree with what gets stored.
test("writeGateFindingsLog trims a padded files[] entry so it matches downstream locatable checks", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-padded-path-"));
  try {
    await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 7,
      gate: "draft_gate",
      headSha: "3333333333333333333300000000000000000000",
      verdict: "clean",
      findings: JSON.stringify([{ severity: "question", angle: "scope", summary: "Why this approach?", files: [" src/a.mjs "], line: 12 }]),
      tmpRoot: tmpDir,
    });
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-7", "draft_gate-3333333333333333333300000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.deepEqual(parsed.findings[0].files, ["src/a.mjs"]);
    assert.equal(parsed.findings[0].disposition, "needs-answer");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

test("checkProvenanceAngleCoverage: a mandatory angle disabled via enabled:false does not deadlock the write", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-exclude-deadlock-"));
  try {
    // The deadlock config: yagni is mandatory AND disabled (enabled: false).
    // Without filtering, every write would fail — missing-mandatory if omitted,
    // foreign if recorded. The disabled entry is excluded from the mandatory
    // check, so the write succeeds with yagni absent from the provenance.
    // Uses the canonical angle-entry shape (#1578): raw mandatoryAngles/
    // excludeAngles keys are rejected by the strict gate schema and would be
    // silently dropped, making this test pin behavior against packaged
    // defaults rather than the override it names.
    await writeFile(path.join(repoRoot, ".devloops"), [
      "version: 1",
      "gates:",
      "  preApproval:",
      "    angles:",
      "      - dry",
      "      - kiss",
      "      - name: pr-checklist-matrix",
      "        mandatory: true",
      "      - name: yagni",
      "        mandatory: true",
      "        enabled: false",
      "",
    ].join("\n"), "utf8");
    // Assert the override actually loaded (not silently dropped against
    // packaged defaults — #1578): a schema-rejected layer would surface a
    // warning from applyLayer. Its absence proves this override took effect,
    // making the coverage assertion below non-vacuous.
    const { loadDevLoopConfig } = await import("@dev-loops/core/config");
    const cfgResult = await loadDevLoopConfig({ repoRoot });
    assert.ok(
      !cfgResult.warnings.some((w) => /config layer rejected by schema/.test(w)),
      "the override layer must load without schema rejection",
    );
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

test("a legacy defer-severity finding normalizes to low in the written log", async () => {
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
    assert.equal(parsed.findings[0].severity, "low"); // "defer" normalizes to canonical "low"
    assert.equal(parsed.findings[0].disposition, "deferred");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// #1616: write-gate-findings-log threads the consolidator's computed
// overallVerdict (carried in consolidate-fanin.mjs's --ledger-out wrapper
// `{ overallVerdict, findings }`) into the durable ledger, so
// upsert-checkpoint-verdict.mjs can enforce verdict consistency against the
// value the fan-in actually computed — not whatever a caller hand-passed as
// --verdict. A bare-array input (legacy/hand-authored) leaves overallVerdict
// absent and writes byte-identically to before.
test("#1616: writeGateFindingsLog persists overallVerdict from the {overallVerdict,findings} wrapper", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-"));
  try {
    const findings = [{ severity: "must-fix", angle: "scope", summary: "blocking finding" }];
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: "findings_present",
      findings: JSON.stringify({ overallVerdict: "findings_present", findings }),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.overallVerdict, "findings_present");
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].severity, "high"); // "must-fix" normalizes to canonical "high"
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1641: writeGateFindingsLog rejects a --verdict contradicting the wrapper overallVerdict", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-conflict-"));
  try {
    // Direction 1: --verdict clean vs wrapper findings_present
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 7,
        gate: "draft_gate",
        headSha: "a1".repeat(20),
        verdict: "clean",
        findings: JSON.stringify({ overallVerdict: "findings_present", findings: [] }),
        tmpRoot: tmpDir,
      }),
      (err) => {
        assert.match(err.message, /--verdict "clean"/);
        assert.match(err.message, /"overallVerdict" "findings_present"/);
        assert.match(err.message, /GATE-COMMENT-VERDICT-VALUES/);
        assert.match(err.message, /skills\/docs\/gate-review-comment-contract\.md/);
        return true;
      },
    );
    // No ledger must be written on the rejection. A non-recursive readdir of
    // tmpDir would only ever see the "gate-findings" directory (buildLogPath
    // nests the ledger three levels below tmpRoot), so it can never observe a
    // leak; assert the actual write target is absent instead.
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: "a1".repeat(20), tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "a contradicting pair must not write a ledger before failing",
    );

    // Direction 2: --verdict findings_present vs wrapper clean
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 8,
        gate: "draft_gate",
        headSha: "b2".repeat(20),
        verdict: "findings_present",
        findings: JSON.stringify({ overallVerdict: "clean", findings: [] }),
        tmpRoot: tmpDir,
      }),
      (err) => {
        assert.match(err.message, /--verdict "findings_present"/);
        assert.match(err.message, /"overallVerdict" "clean"/);
        return true;
      },
    );

    // Direction 3: --verdict blocked vs wrapper findings_present (issue's
    // Domain bullet names this pair explicitly).
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 9,
        gate: "draft_gate",
        headSha: "c3".repeat(20),
        verdict: "blocked",
        findings: JSON.stringify({ overallVerdict: "findings_present", findings: [] }),
        tmpRoot: tmpDir,
      }),
      (err) => {
        assert.match(err.message, /--verdict "blocked"/);
        assert.match(err.message, /"overallVerdict" "findings_present"/);
        return true;
      },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1641: writeGateFindingsLog rejects an invalid or non-string caller --verdict as a domain error, not a contradiction", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-invalid-"));
  try {
    for (const badVerdict of ["bogus", undefined, ["clean"]]) {
      await assert.rejects(
        () => writeGateFindingsLog({
          repo: "o/n",
          pr: 7,
          gate: "draft_gate",
          headSha: "a1".repeat(20),
          verdict: badVerdict,
          findings: JSON.stringify({ overallVerdict: "clean", findings: [] }),
          tmpRoot: tmpDir,
        }),
        (err) => {
          assert.match(err.message, /--verdict must be clean, findings_present, or blocked/);
          assert.doesNotMatch(err.message, /contradicts/);
          return true;
        },
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1641: writeGateFindingsLog accepts a matching --verdict + wrapper overallVerdict", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-match-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: "findings_present",
      findings: JSON.stringify({ overallVerdict: "findings_present", findings: [] }),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.verdict, "findings_present");
    assert.equal(parsed.overallVerdict, "findings_present");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1641: writeGateFindingsLog accepts a non-canonical caller --verdict and persists the canonical value", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-noncanonical-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: " Clean ",
      findings: JSON.stringify({ overallVerdict: "clean", findings: [] }),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.verdict, "clean", "the ledger must persist the canonical verdict, not the raw caller casing/whitespace");
    assert.equal(parsed.overallVerdict, "clean");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1641: CLI path — a direct write-gate-findings-log.mjs with a contradicting pair exits 1 with {ok:false,error} and writes no ledger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-cli-conflict-"));
  try {
    // Wrapper overallVerdict findings_present contradicts --verdict clean.
    const result = await runNodeHelper(writeGateFindingsLogScript, [
      "--repo", "owner/repo",
      "--pr", "42",
      "--gate", "draft_gate",
      "--head-sha", "945391c0abcdef1234567890abcdef1234567890",
      "--verdict", "clean",
      "--findings", JSON.stringify({ overallVerdict: "findings_present", findings: [] }),
      "--tmp-root", tmpDir,
    ], { cwd: tmpDir });

    assert.equal(result.code, 1, "a contradicting pair must exit 1");
    assert.match(result.stderr, /\{"ok":false,"error"/);
    assert.match(result.stderr, /contradicts the wrapper/);
    assert.match(result.stderr, /GATE-COMMENT-VERDICT-VALUES/);

    // No ledger must be written on the rejection. Same non-recursive-readdir
    // caveat as the programmatic-path test above: assert the actual write
    // target is absent instead of scanning tmpDir's top level.
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "945391c0abcdef1234567890abcdef1234567890", tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "a contradicting CLI pair must not write a ledger before failing",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The contradiction-refusal tests above all drive the wrapper through inline
// --findings; this one drives the SAME refusal through --findings-file (a
// wrapper-shaped file). The refusal itself (both the caller-verdict domain
// check and the wrapper-contradiction check) lives in writeGateFindingsLog,
// not in resolveFindingsInput — resolveFindingsInput's shared plumbing only
// parses and unwraps the wrapper identically for both flags, which is why the
// same refusal reaches the findings-file path too.
test("writeGateFindingsLog rejects a --verdict contradicting a --findings-file wrapper overallVerdict", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-file-conflict-"));
  try {
    const findingsFile = path.join(tmpDir, "findings.json");
    await writeFile(findingsFile, JSON.stringify({ overallVerdict: "findings_present", findings: [] }), "utf8");
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 7,
        gate: "draft_gate",
        headSha: "a1".repeat(20),
        verdict: "clean",
        findingsFile,
        tmpRoot: tmpDir,
      }),
      (err) => {
        assert.match(err.message, /--verdict "clean"/);
        assert.match(err.message, /"overallVerdict" "findings_present"/);
        assert.match(err.message, /GATE-COMMENT-VERDICT-VALUES/);
        return true;
      },
    );
    // No ledger must be written on the rejection.
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: "a1".repeat(20), tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "a contradicting --findings-file pair must not write a ledger before failing",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1616: writeGateFindingsLog rejects a malformed wrapper overallVerdict", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-bad-"));
  try {
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 7,
        gate: "draft_gate",
        headSha: "a1".repeat(20),
        verdict: "clean",
        findings: JSON.stringify({ overallVerdict: "bogus", findings: [] }),
        tmpRoot: tmpDir,
      }),
      /"overallVerdict" must be one of: clean, findings_present, or blocked/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The verdict domain guard previously lived only inside the wrapper branch —
// a bare-array input (no overallVerdict) skipped it entirely and would have
// persisted an invalid/non-string --verdict straight into the ledger.
test("writeGateFindingsLog rejects an invalid --verdict on a bare-array input (no wrapper) as a domain error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-bare-invalid-verdict-"));
  try {
    for (const badVerdict of ["bogus", undefined, ["clean"]]) {
      await assert.rejects(
        () => writeGateFindingsLog({
          repo: "o/n",
          pr: 7,
          gate: "draft_gate",
          headSha: "a1".repeat(20),
          verdict: badVerdict,
          findings: "[]",
          tmpRoot: tmpDir,
        }),
        /--verdict must be clean, findings_present, or blocked/,
      );
    }
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: "a1".repeat(20), tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "an invalid bare-array verdict must not write a ledger before failing",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The bare-array path (no overallVerdict wrapper) is the one the canonical-
// persistence acceptance criterion actually changed: before this change the
// ledger persisted the raw --verdict string unchanged on this path. Pinning
// canonicalization only through a wrapper-shaped payload (as the test above
// does) leaves this half unasserted — a regression that dropped the hoisted
// normalization while keeping the hoisted rejection would still pass every
// other test in this suite.
test("writeGateFindingsLog canonicalizes a non-canonical caller --verdict on a bare-array input (no wrapper)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-bare-noncanonical-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: " Clean ",
      findings: "[]",
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.verdict, "clean", "a bare-array write must persist the canonical verdict, not the raw caller casing/whitespace");
    assert.ok(!("overallVerdict" in parsed), "a bare-array input must not synthesize an overallVerdict");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The no-mutation clause: writeGateFindingsLog persists the canonical verdict
// into the ledger without mutating the caller-supplied options object, since
// a programmatic caller may reuse one options object across calls. A snapshot
// comparison catches an in-place mutant (e.g. options.verdict = callerVerdict)
// that would otherwise pass every other test in this suite unnoticed.
test("writeGateFindingsLog does not mutate the caller-supplied options object", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-no-mutate-"));
  try {
    const options = {
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: " Clean ",
      findings: "[]",
      tmpRoot: tmpDir,
    };
    const snapshot = structuredClone(options);
    await writeGateFindingsLog(options);
    assert.deepEqual(options, snapshot, "writeGateFindingsLog must not mutate the caller-supplied options object");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// normalizeVerdict coerces via String(), so an array-wrapped wrapper verdict
// like ["clean"] stringifies to the bare string "clean" — without a typeof
// guard BEFORE normalization this would silently pass as a valid wrapper
// instead of being rejected as malformed.
test("writeGateFindingsLog rejects an array-wrapped wrapper overallVerdict instead of string-coercing it", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-array-"));
  try {
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 7,
        gate: "draft_gate",
        headSha: "a1".repeat(20),
        verdict: "clean",
        findings: JSON.stringify({ overallVerdict: ["clean"], findings: [] }),
        tmpRoot: tmpDir,
      }),
      /"overallVerdict" must be one of: clean, findings_present, or blocked/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("#1616: writeGateFindingsLog omits overallVerdict for a bare-array input (legacy unchanged)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-ov-absent-"));
  try {
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 7,
      gate: "draft_gate",
      headSha: "a1".repeat(20),
      verdict: "clean",
      findings: JSON.stringify([]),
      tmpRoot: tmpDir,
    });
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.ok(!("overallVerdict" in parsed), "a bare-array input must not synthesize an overallVerdict");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// #1525: the --judge-verdict flag enriches findings with the judge agent's
// relevance-based dispositions (act/defer/reject + rationale + follow-up
// drafts) before writing the ledger, and records the scope-drift verdict.
test("writeGateFindingsLog enriches findings from --judge-verdict and records scopeDrift (#1525)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-judge-"));
  try {
    const judgeVerdictPath = path.join(tmpDir, "judge-verdict.json");
    await writeFile(judgeVerdictPath, JSON.stringify({
      headSha: "abc1234567890abcdef000000000000000000000",
      scopeDrift: { verdict: "drift_detected", rationale: "diff adds a CLI flag not in any AC", driftedAreas: ["cli surface"] },
      dispositions: [
        { index: 0, disposition: "act", rationale: "fixes the defect named in AC-1", criterion: "AC-1" },
        { index: 1, disposition: "reject", rationale: "style churn excluded by non-goal 3", criterion: "Non-goal 3" },
      ],
    }), "utf8");

    const result = await writeGateFindingsLog({
      repo: "owner/repo",
      pr: 42,
      gate: "draft_gate",
      headSha: "abc1234567890abcdef000000000000000000000",
      verdict: "findings_present",
      findings: JSON.stringify([
        { severity: "must-fix", angle: "correctness", summary: "null deref", disposition: "accepted-for-fix" },
        { severity: "low", angle: "docs", summary: "rename variable", disposition: "deferred" },
      ]),
      judgeVerdict: judgeVerdictPath,
      tmpRoot: tmpDir,
    });

    assert.equal(result.ok, true);
    const fullPath = path.join(tmpDir, "gate-findings", "owner-repo", "pr-42", "draft_gate-abc1234567890abcdef000000000000000000000.json");
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    assert.equal(parsed.findings[0].judgeDisposition, "act");
    assert.equal(parsed.findings[0].judgeRationale, "fixes the defect named in AC-1");
    assert.equal(parsed.findings[1].judgeDisposition, "reject");
    assert.equal(parsed.scopeDrift.verdict, "drift_detected");
    assert.deepEqual(parsed.scopeDrift.driftedAreas, ["cli surface"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The --judge-verdict path inherits applyJudgeDispositions's coverage
// fail-closed check the same as the pure seam and runJudgePass: a verdict
// that leaves a finding undisposed must abort the write rather than persist
// a ledger with a silently-dropped finding.
test("writeGateFindingsLog --judge-verdict fails closed when the verdict does not dispose every finding and writes no ledger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-judge-coverage-"));
  try {
    const headSha = "d4".repeat(20);
    const judgeVerdictPath = path.join(tmpDir, "judge-verdict.json");
    await writeFile(judgeVerdictPath, JSON.stringify({
      headSha,
      scopeDrift: { verdict: "within_scope", rationale: "matches the briefed AC set", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "act", rationale: "fixes the defect named in AC-1", criterion: "AC-1" },
      ],
    }), "utf8");

    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 23,
        gate: "draft_gate",
        headSha,
        verdict: "findings_present",
        findings: JSON.stringify([
          { severity: "must-fix", angle: "correctness", summary: "null deref", disposition: "accepted-for-fix" },
          { severity: "low", angle: "docs", summary: "rename variable", disposition: "deferred" },
        ]),
        judgeVerdict: judgeVerdictPath,
        tmpRoot: tmpDir,
      }),
      /does not dispose 1 finding\(s\) \(indexes: 1\)/,
    );
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "o/n", pr: 23, gate: "draft_gate", headSha, tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "an undisposed-finding verdict must not write a ledger",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// #1745: a wrapper carrying overallVerdict PLUS --judge-verdict on the same
// call. The judge only enriches findings with act/defer/reject dispositions
// (applyJudgeDispositions); it never revises the round verdict, so the
// write-time contradiction refusal ALWAYS compares --verdict against the
// wrapper's overallVerdict. Arm (b)'s judge artifact is adversarial: it
// rejects the only finding, agreeing with the caller's contradicting "clean"
// verdict rather than the wrapper's "findings_present" — a judge-consulting
// implementation would accept "clean" here, so the refusal firing anyway
// proves the comparison never falls back to the judge artifact's content.
test("#1745: writeGateFindingsLog with wrapper overallVerdict + --judge-verdict: matching --verdict succeeds with enrichment, contradicting --verdict refuses against the wrapper regardless of the judge artifact", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-judge-verdict-conflict-"));
  try {
    const headSha = "c3".repeat(20);
    const judgeVerdictPath = path.join(tmpDir, "judge-verdict.json");
    await writeFile(judgeVerdictPath, JSON.stringify({
      headSha,
      scopeDrift: { verdict: "within_scope", rationale: "matches the briefed AC set", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "act", rationale: "fixes the defect named in AC-1", criterion: "AC-1" },
      ],
    }), "utf8");
    const findings = JSON.stringify({
      overallVerdict: "findings_present",
      findings: [
        { severity: "must-fix", angle: "correctness", summary: "null deref", disposition: "accepted-for-fix" },
      ],
    });

    // (a) A matching --verdict succeeds and judge enrichment is applied.
    const result = await writeGateFindingsLog({
      repo: "o/n",
      pr: 21,
      gate: "draft_gate",
      headSha,
      verdict: "findings_present",
      findings,
      judgeVerdict: judgeVerdictPath,
      tmpRoot: tmpDir,
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(parsed.overallVerdict, "findings_present");
    assert.equal(parsed.findings[0].judgeDisposition, "act");

    // (b) A contradicting --verdict refuses, naming the wrapper's
    // overallVerdict as the consolidator's authoritative round verdict. This
    // arm's judge artifact is adversarial: it dispositions the only finding
    // "reject" (out of scope), which agrees with the caller's contradicting
    // "clean" verdict, not with the wrapper's "findings_present". A
    // judge-consulting implementation would derive "no actionable findings"
    // from that and accept "clean"; this pin proves the refusal still fires
    // and still names the wrapper as its source regardless of the judge.
    const headShaB = "d4".repeat(20);
    const judgeVerdictPathB = path.join(tmpDir, "judge-verdict-adversarial.json");
    await writeFile(judgeVerdictPathB, JSON.stringify({
      headSha: headShaB,
      scopeDrift: { verdict: "within_scope", rationale: "matches the briefed AC set", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "reject", rationale: "out of scope against non-goal 3", criterion: "Non-goal 3" },
      ],
    }), "utf8");
    await assert.rejects(
      () => writeGateFindingsLog({
        repo: "o/n",
        pr: 22,
        gate: "draft_gate",
        headSha: headShaB,
        verdict: "clean",
        findings,
        judgeVerdict: judgeVerdictPathB,
        tmpRoot: tmpDir,
      }),
      (err) => {
        assert.match(err.message, /--verdict "clean"/);
        assert.match(err.message, /"overallVerdict" "findings_present"/);
        assert.match(err.message, /consolidator's computed round verdict/);
        assert.match(err.message, /GATE-COMMENT-VERDICT-VALUES/);
        return true;
      },
    );
    await assert.rejects(
      () => readFile(buildLogPath({ repo: "o/n", pr: 22, gate: "draft_gate", headSha: headShaB, tmpRoot: tmpDir }), "utf8"),
      /ENOENT/,
      "a contradicting pair must not write a ledger before failing, even with --judge-verdict attached",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
