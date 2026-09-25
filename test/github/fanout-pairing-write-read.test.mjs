// Pairing guard (fanoutReviewerPairingError) at write time
// (writeGateFindingsLog) and at read time (buildFanoutEnforcement +
// buildPreMergeGateCheck). Both re-derive the round's dispatch units with
// resolveFanoutGroups from the ledger. Covers: holistic sharing a reviewer in
// its auto-chunk unit (accepted), a reviewer shared across units (rejected),
// and a round where one angle of a unit is carried and the rest are fresh
// (accepted: the re-derivation must match the emitted grouping).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";
import { loadDevLoopConfig, resolveFanoutGroups } from "@dev-loops/core/config";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";

const HEAD_SHA = "d".repeat(40);
// maxAnglesPerGroup 2 keeps the leftover pool small: the configured "process"
// group takes pr-checklist; holistic, dry, kiss, yagni auto-chunk into
// [holistic, dry] and [kiss, yagni].
const DEVLOOPS = [
  "version: 1",
  "gates:",
  "  requireFanoutEvidence: true",
  "  requireFanoutProvenance: true",
  "  preApproval:",
  "    angles:",
  "      - name: pr-checklist",
  "        mandatory: true",
  "      - name: holistic",
  "        mandatory: true",
  "      - dry",
  "      - kiss",
  "      - yagni",
  "  fanout:",
  "    maxAnglesPerGroup: 2",
  "    groups:",
  "      - name: process",
  "        angles: [pr-checklist]",
  "",
].join("\n");

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pairing-"));
  try {
    await writeFile(path.join(dir, ".devloops"), DEVLOOPS, "utf8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeCheck(dir, perAngle) {
  const tmpRoot = path.join(dir, "out");
  try {
    await writeGateFindingsLog({
      repo: "owner/repo", pr: 5, gate: "pre_approval_gate", headSha: HEAD_SHA,
      verdict: "clean", findings: "[]",
      provenance: JSON.stringify({ distinctReviewers: countIds(perAngle), perAngle }),
      tmpRoot,
    }, { repoRoot: dir });
    return null;
  } catch (error) {
    return error.message;
  }
}

async function readCheck(dir, perAngle) {
  const ledgerDir = path.join(dir, "tmp", "gate-findings", "owner-repo", "pr-5");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(
    path.join(ledgerDir, `pre_approval_gate-${HEAD_SHA}.json`),
    `${JSON.stringify({ gate: "pre_approval_gate", headSha: HEAD_SHA, findings: [], provenance: { distinctReviewers: countIds(perAngle), perAngle } })}\n`,
    "utf8",
  );
  const { config } = await loadDevLoopConfig({ repoRoot: dir });
  const enforcement = await buildFanoutEnforcement({
    repo: "owner/repo", pr: 5, currentHeadSha: HEAD_SHA,
    draftGateMarker: { visible: false },
    preApprovalGateMarker: { visible: true, headSha: HEAD_SHA, executionMode: "fanout_fanin" },
    config, cwd: dir, hasFullLabel: false,
  });
  const result = buildPreMergeGateCheck({
    currentHeadSha: HEAD_SHA,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD_SHA, sizeOutcome: "pass", sizeTouchesT1: false },
  }, 0, null, enforcement);
  return result.ok ? null : result.failures.join("\n");
}

function countIds(perAngle) {
  return new Set(perAngle.filter((e) => !e.carriedFromHead).map((e) => e.reviewer)).size;
}

async function bothChecks(perAngle) {
  return withRepo(async (dir) => ({ write: await writeCheck(dir, perAngle), read: await readCheck(dir, perAngle) }));
}

describe("fanoutReviewerPairingError at write time and read time", () => {
  test("fixture: the emitted grouping over the round's full angle set", async () => {
    await withRepo(async (dir) => {
      const { config } = await loadDevLoopConfig({ repoRoot: dir });
      const angles = ["pr-checklist", "holistic", "dry", "kiss", "yagni"];
      assert.deepEqual(resolveFanoutGroups(config, "preApproval", angles), [
        { name: "process", angles: ["pr-checklist"] },
        { name: "group:holistic+dry", angles: ["holistic", "dry"] },
        { name: "group:kiss+yagni", angles: ["kiss", "yagni"] },
      ]);
    });
  });

  test("holistic sharing a reviewer with another angle of its auto-chunk unit passes both checks", async () => {
    const { write, read } = await bothChecks([
      { angle: "pr-checklist", reviewer: "r1", group: "process" },
      { angle: "holistic", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "dry", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "kiss", reviewer: "r3", group: "group:kiss+yagni" },
      { angle: "yagni", reviewer: "r3", group: "group:kiss+yagni" },
    ]);
    assert.equal(write, null);
    assert.equal(read, null);
  });

  test("a reviewer shared across two units fails both checks", async () => {
    const { write, read } = await bothChecks([
      { angle: "pr-checklist", reviewer: "r1", group: "process" },
      { angle: "holistic", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "dry", reviewer: "r3", group: "group:holistic+dry" },
      { angle: "kiss", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "yagni", reviewer: "r3", group: "group:kiss+yagni" },
    ]);
    assert.match(write ?? "", /does not place all of them in one group/);
    assert.match(read ?? "", /does not place all of them in one group/);
  });

  // dry is carried from the prior head, the rest of the round is fresh. The
  // emitter dispatched [holistic, dry] and [kiss, yagni]. Re-deriving from the
  // fresh angles alone would chunk [holistic, kiss] and [yagni] and reject the
  // honest kiss+yagni reviewer.
  test("a mixed carried and fresh round with a shared reviewer inside one unit passes both checks", async () => {
    const { write, read } = await bothChecks([
      { angle: "pr-checklist", reviewer: "r1", group: "process" },
      { angle: "holistic", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "dry", reviewer: "r0", group: "group:holistic+dry", carriedFromHead: "abc1234" },
      { angle: "kiss", reviewer: "r3", group: "group:kiss+yagni" },
      { angle: "yagni", reviewer: "r3", group: "group:kiss+yagni" },
    ]);
    assert.equal(write, null);
    assert.equal(read, null);
  });

  test("a mixed carried and fresh round still fails both checks for a reviewer shared across units", async () => {
    const { write, read } = await bothChecks([
      { angle: "pr-checklist", reviewer: "r1", group: "process" },
      { angle: "holistic", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "dry", reviewer: "r0", group: "group:holistic+dry", carriedFromHead: "abc1234" },
      { angle: "kiss", reviewer: "r2", group: "group:holistic+dry" },
      { angle: "yagni", reviewer: "r3", group: "group:kiss+yagni" },
    ]);
    assert.match(write ?? "", /does not place all of them in one group/);
    assert.match(read ?? "", /does not place all of them in one group/);
  });
});
