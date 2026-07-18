// Regression coverage for #1407: write-gate-findings-log.mjs used to accept a
// SHORT --head-sha and key the ledger PATH on it verbatim, while the pre-merge
// reader (detect-checkpoint-evidence's buildFanoutEnforcement) always resolves
// and looks up the FULL head SHA — so a short-SHA write produced an unfindable
// ledger and a false "missing evidence" block. The fix requires the primary
// --head-sha to be the FULL 40/64-hex commit SHA and fail closed on a prefix.
// This test proves, end-to-end, both the fail-closed short-SHA path and the
// write -> read agreement for a full head SHA.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode as runNodeHelper } from "../_helpers.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildFanoutEnforcement } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { parseUpsertCheckpointVerdictCliArgs } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

const writeGateFindingsLogScript = path.resolve("scripts/github/write-gate-findings-log.mjs");

test("write-gate-findings-log (#1407): a SHORT --head-sha fails closed and writes no ledger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-full-head-sha-short-"));
  try {
    const result = await runNodeHelper(writeGateFindingsLogScript, [
      "--repo", "owner/repo",
      "--pr", "42",
      "--gate", "draft_gate",
      "--head-sha", "945391c0",
      "--verdict", "clean",
      "--findings", "[]",
    ], { cwd: tmpDir });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FULL head commit SHA|40 or 64 hex/);

    const shortLedgerPath = buildLogPath({
      repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "945391c0", tmpRoot: "tmp",
    });
    await assert.rejects(() => access(path.join(tmpDir, shortLedgerPath)));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("write-gate-findings-log (#1407): a FULL 40-hex --head-sha writes the ledger detect-checkpoint-evidence finds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-full-head-sha-full-"));
  try {
    const fullHeadSha = "945391c0abcdef1234567890abcdef1234567890";
    const result = await runNodeHelper(writeGateFindingsLogScript, [
      "--repo", "owner/repo",
      "--pr", "42",
      "--gate", "draft_gate",
      "--head-sha", fullHeadSha,
      "--verdict", "clean",
      "--findings", "[]",
    ], { cwd: tmpDir });

    assert.equal(result.code, 0, result.stderr);

    const ledgerPath = buildLogPath({
      repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: fullHeadSha, tmpRoot: "tmp",
    });
    await access(path.join(tmpDir, ledgerPath)); // does not throw: ledger exists on disk

    // Write -> read agreement: the pre-merge reader's ledger-existence path
    // (buildFanoutEnforcement) must find the SAME ledger via the SAME full
    // head SHA. tmpDir is outside any git repo, so resolveLedgerCheckouts
    // falls back to cwd (no git init needed here). requireFanoutEvidence
    // defaults on for an empty config.
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo",
      pr: 42,
      currentHeadSha: fullHeadSha,
      draftGateMarker: { visible: true, headSha: fullHeadSha, executionMode: "fanout_fanin" },
      preApprovalGateMarker: { visible: false, headSha: null },
      config: {},
      cwd: tmpDir,
    });
    const draftGate = enforcement.gates.find((g) => g.name === "draft_gate");
    assert.ok(draftGate, "draft_gate entry missing from buildFanoutEnforcement result");
    assert.equal(draftGate.ledgerExists, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict (#1407): a SHORT --head-sha also fails closed at parse time", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([
      "--repo", "owner/repo",
      "--pr", "42",
      "--gate", "draft_gate",
      "--head-sha", "945391c0",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ]),
    /FULL head commit SHA|40 or 64 hex/,
  );
});
