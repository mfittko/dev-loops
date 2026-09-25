// Pairing guard (fanoutReviewerPairingError) at write time
// (writeGateFindingsLog) and at read time (buildFanoutEnforcement +
// buildPreMergeGateCheck). Both re-derive the round's base units with
// resolveFanoutGroups from the ledger and, for packed rounds, check the
// recorded dispatch membership against them. Covers: holistic sharing a reviewer in
// its auto-chunk unit (accepted), a reviewer shared across units (rejected),
// and a round where one angle of a unit is carried and the rest are fresh
// (accepted: the re-derivation must match the emitted grouping).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";
import { loadDevLoopConfig, resolveFanoutGroups, resolveGateAngleContract } from "@dev-loops/core/config";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { expandDispatchUnits } from "../../scripts/github/_dispatch-units.mjs";
import { buildGateContextPath, resolveFanoutDispatch } from "../../scripts/github/write-gate-context.mjs";

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

// Packed rounds: write-gate-context.mjs merges whole base units into at most
// maxConcurrent units, the findings-log writer records that dispatch
// membership from the context artifact, and both checks honor a shared
// reviewer only inside one recorded unit that is a union of whole base units.
// maxConcurrent 2 over four base units (process 1, alpha 2, beta 2, holistic 1)
// packs into alpha+beta+holistic (5) and process (1).
const PACK_DEVLOOPS = [
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
  "      - deep",
  "  fanout:",
  "    maxConcurrent: 2",
  "    groups:",
  "      - name: process",
  "        angles: [pr-checklist]",
  "      - name: alpha",
  "        angles: [dry, kiss]",
  "      - name: beta",
  "        angles: [yagni, deep]",
  "",
].join("\n");
const PACK_ANGLES = ["pr-checklist", "holistic", "dry", "kiss", "yagni", "deep"];

async function withConfig(devloops, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pack-pairing-"));
  try {
    await writeFile(path.join(dir, ".devloops"), devloops, "utf8");
    const { config } = await loadDevLoopConfig({ repoRoot: dir });
    return await fn(dir, config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OUT = "out";
const GATE_KEY = { draft_gate: "draft", pre_approval_gate: "preApproval" };

// Write the keyed gate-context artifact the findings-log writer reads its
// dispatch membership from, then write the ledger through the real writer.
async function writePacked(dir, gate, groups, perAngle) {
  const contextPath = path.join(dir, buildGateContextPath({ repo: "owner/repo", pr: 5, gate, headSha: HEAD_SHA, tmpRoot: OUT }));
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(contextPath, JSON.stringify({ fanout: { groups, pendingGroups: groups } }), "utf8");
  try {
    const result = await writeGateFindingsLog({
      repo: "owner/repo", pr: 5, gate, headSha: HEAD_SHA, verdict: "clean", findings: "[]",
      provenance: JSON.stringify({ distinctReviewers: countIds(perAngle), perAngle }),
      tmpRoot: OUT,
    }, { repoRoot: dir });
    return { error: null, provenance: result.log.provenance };
  } catch (error) {
    return { error: error.message, provenance: null };
  }
}

async function readPacked(dir, gate, provenance) {
  const ledgerDir = path.join(dir, "tmp", "gate-findings", "owner-repo", "pr-5");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(path.join(ledgerDir, `${gate}-${HEAD_SHA}.json`), `${JSON.stringify({ gate, headSha: HEAD_SHA, findings: [], provenance })}\n`, "utf8");
  const { config } = await loadDevLoopConfig({ repoRoot: dir });
  const marker = { visible: true, headSha: HEAD_SHA, executionMode: "fanout_fanin" };
  const enforcement = await buildFanoutEnforcement({
    repo: "owner/repo", pr: 5, currentHeadSha: HEAD_SHA,
    draftGateMarker: gate === "draft_gate" ? marker : { visible: false },
    preApprovalGateMarker: gate === "pre_approval_gate" ? marker : { visible: false },
    config, cwd: dir, hasFullLabel: false,
  });
  const result = buildPreMergeGateCheck({
    currentHeadSha: HEAD_SHA,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD_SHA, sizeOutcome: "pass", sizeTouchesT1: false },
  }, 0, null, enforcement);
  const failures = (result.failures ?? []).filter((f) => f.startsWith(`${gate}:`));
  return failures.length === 0 ? null : failures.join("\n");
}

// One reviewer per emitted dispatch unit, with the emitter's provenance group.
function perUnitProvenance(units) {
  return units.flatMap((unit, index) => unit.angles.map((angle) => ({ angle, reviewer: `r${index}`, ...(unit.group === null ? {} : { group: unit.group }) })));
}

describe("fanoutReviewerPairingError against recorded dispatch membership (packed rounds)", () => {
  test("fixture: four base units pack into two units, and the ledger records that membership", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir, config) => {
      const plan = resolveFanoutDispatch(config, "preApproval", PACK_ANGLES, { env: {} });
      assert.deepEqual(plan.groups, [
        { name: "alpha+beta+holistic", angles: ["dry", "kiss", "yagni", "deep", "holistic"] },
        // Packing merges emitter base units; a singleton base unit is named by its angle.
        { name: "pr-checklist", angles: ["pr-checklist"] },
      ]);
      const units = expandDispatchUnits(plan.groups, new Set(["process", "alpha", "beta"]));
      const { error, provenance } = await writePacked(dir, "pre_approval_gate", plan.groups, perUnitProvenance(units));
      assert.equal(error, null);
      assert.deepEqual(provenance.dispatchUnits, [
        { name: "alpha+beta+holistic", angles: ["dry", "kiss", "yagni", "deep", "holistic"] },
        // A one-angle packed unit dispatches as a singleton named by its angle.
        { name: "pr-checklist", angles: ["pr-checklist"] },
      ]);
    });
  });

  test("ACCEPT: one reviewer for a packed unit spanning two configured groups passes both checks", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir, config) => {
      const plan = resolveFanoutDispatch(config, "preApproval", PACK_ANGLES, { env: {} });
      const units = expandDispatchUnits(plan.groups, new Set());
      const { error, provenance } = await writePacked(dir, "pre_approval_gate", plan.groups, perUnitProvenance(units));
      assert.equal(error, null);
      assert.equal(await readPacked(dir, "pre_approval_gate", provenance), null);
    });
  });

  test("REJECT: a reviewer shared across two recorded units fails both checks", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir, config) => {
      const plan = resolveFanoutDispatch(config, "preApproval", PACK_ANGLES, { env: {} });
      const perAngle = PACK_ANGLES.map((angle) => ({ angle, reviewer: angle === "pr-checklist" || angle === "holistic" ? "shared" : "r-pack", group: "alpha+beta+holistic" }));
      const { error } = await writePacked(dir, "pre_approval_gate", plan.groups, perAngle);
      assert.match(error ?? "", /recorded dispatch units does not place all of them in one group/);
      const units = expandDispatchUnits(plan.groups, new Set());
      const read = await readPacked(dir, "pre_approval_gate", { distinctReviewers: 2, perAngle, dispatchUnits: units.map(({ name, angles }) => ({ name, angles })) });
      assert.match(read ?? "", /recorded dispatch units does not place all of them in one group/);
    });
  });

  test("REJECT: a recorded unit that splits a base unit fails both checks", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir) => {
      // dry+yagni takes one angle each from alpha and beta.
      const groups = [
        { name: "mixed", angles: ["dry", "yagni"] },
        { name: "rest", angles: ["kiss", "deep", "holistic"] },
        { name: "process", angles: ["pr-checklist"] },
      ];
      const perAngle = perUnitProvenance(expandDispatchUnits(groups, new Set()));
      const { error } = await writePacked(dir, "pre_approval_gate", groups, perAngle);
      assert.match(error ?? "", /is not a union of whole base units/);
      const read = await readPacked(dir, "pre_approval_gate", { distinctReviewers: 3, perAngle, dispatchUnits: groups });
      assert.match(read ?? "", /is not a union of whole base units/);
    });
  });

  test("REJECT: a recorded unit above 5 angles fails the read check (the writer's cap-split never records one)", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir) => {
      const dispatchUnits = [{ name: "all", angles: PACK_ANGLES }];
      const perAngle = PACK_ANGLES.map((angle) => ({ angle, reviewer: angle === "pr-checklist" ? "r-pr" : "r-all", group: "all" }));
      const read = await readPacked(dir, "pre_approval_gate", { distinctReviewers: 2, perAngle, dispatchUnits });
      assert.match(read ?? "", /holds 6 angles, above the 5-angle unit bound/);
    });
  });

  test("a ledger without recorded membership falls back to base units: an unpacked round passes, a packed reviewer fails closed", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir, config) => {
      const unpacked = perUnitProvenance(expandDispatchUnits(resolveFanoutGroups(config, "preApproval", PACK_ANGLES), new Set()));
      assert.equal(await readPacked(dir, "pre_approval_gate", { distinctReviewers: countIds(unpacked), perAngle: unpacked }), null);
      const plan = resolveFanoutDispatch(config, "preApproval", PACK_ANGLES, { env: {} });
      const packed = perUnitProvenance(expandDispatchUnits(plan.groups, new Set()));
      assert.match(await readPacked(dir, "pre_approval_gate", { distinctReviewers: countIds(packed), perAngle: packed }) ?? "", /configured gates.fanout.groups table does not place all of them in one group/);
    });
  });

  test("changing the harness clamp between write and read leaves the verdict unchanged", async () => {
    // maxConcurrent 8 over 6 base units: the Claude clamp (5) packs, a Pi env
    // would not. The recorded membership, not the reader's harness, decides.
    // maxAnglesPerGroup 1 keeps the leftover angles as singleton base units.
    const devloops = PACK_DEVLOOPS
      .replace("maxConcurrent: 2", "maxConcurrent: 8\n    maxAnglesPerGroup: 1")
      .replace("      - deep\n", "      - deep\n      - srp\n      - soc\n");
    await withConfig(devloops, async (dir, config) => {
      const angles = [...PACK_ANGLES, "srp", "soc"];
      const claude = resolveFanoutDispatch(config, "preApproval", angles, { env: { CLAUDECODE: "1" } });
      const pi = resolveFanoutDispatch(config, "preApproval", angles, { env: {} });
      assert.ok(claude.groups.length <= 5);
      assert.ok(pi.groups.length > claude.groups.length);
      const units = expandDispatchUnits(claude.groups, new Set());
      const { error, provenance } = await writePacked(dir, "pre_approval_gate", claude.groups, perUnitProvenance(units));
      assert.equal(error, null);
      const original = process.env.CLAUDECODE;
      try {
        process.env.CLAUDECODE = "1";
        const underClaude = await readPacked(dir, "pre_approval_gate", provenance);
        delete process.env.CLAUDECODE;
        const underPi = await readPacked(dir, "pre_approval_gate", provenance);
        assert.equal(underClaude, null);
        assert.equal(underPi, underClaude);
      } finally {
        if (original === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = original;
      }
    });
  });

  for (const gate of ["draft_gate", "pre_approval_gate"]) {
    test(`rollback: the holistic singleton override's provenance passes both checks (${gate}) and is never merged when the round fits`, async () => {
      const devloops = [
        "version: 1",
        "gates:",
        "  requireFanoutEvidence: true",
        "  requireFanoutProvenance: true",
        "  fanout:",
        "    groups:",
        "      - name: holistic",
        "        angles: [holistic]",
        "",
      ].join("\n");
      await withConfig(devloops, async (dir, config) => {
        const { pool, mandatoryAngles } = resolveGateAngleContract(config, GATE_KEY[gate]);
        const angles = [...new Set([...mandatoryAngles, "holistic", ...pool])].slice(0, 12);
        const plan = resolveFanoutDispatch(config, GATE_KEY[gate], angles, { env: { CLAUDECODE: "1" } });
        const units = expandDispatchUnits(plan.groups, new Set(config.gates.fanout.groups.map((g) => g.name)));
        assert.ok(units.length <= 5);
        const holisticUnits = units.filter((u) => u.angles.includes("holistic"));
        assert.deepEqual(holisticUnits.map((u) => u.angles), [["holistic"]]);
        const { error, provenance } = await writePacked(dir, gate, plan.groups, perUnitProvenance(units));
        assert.equal(error, null);
        assert.equal(await readPacked(dir, gate, provenance), null);
      });
    });
  }
});

// Empty or malformed recorded membership never skips the membership check.
describe("fanoutReviewerPairingError fails closed on empty recorded membership", () => {
  // Two reviewers meet the distinctReviewers floor; one of them spans five
  // angles across three base units, which only a skipped membership check passes.
  const spanning = PACK_ANGLES.map((angle) => (angle === "pr-checklist" ? { angle, reviewer: "r-pr", group: "process" } : { angle, reviewer: "one", group: "all" }));
  test("REJECT: dispatchUnits [] on the write side (context fanout.groups []) and on the read side", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir) => {
      const perAngle = spanning;
      const { error } = await writePacked(dir, "pre_approval_gate", [], perAngle);
      assert.match(error ?? "", /invalid dispatch unit membership: dispatchUnits is empty/);
      const read = await readPacked(dir, "pre_approval_gate", { distinctReviewers: 2, perAngle, dispatchUnits: [] });
      assert.match(read ?? "", /invalid dispatch unit membership: dispatchUnits is empty/);
    });
  });

  test("REJECT: a context whose fanout.groups holds only malformed or angle-less entries", async () => {
    await withConfig(PACK_DEVLOOPS, async (dir) => {
      const perAngle = spanning;
      const { error } = await writePacked(dir, "pre_approval_gate", [null, "junk", { name: "x" }, { name: "y", angles: [] }, { angles: [" "] }], perAngle);
      assert.match(error ?? "", /invalid dispatch unit membership: dispatchUnits is empty/);
    });
  });
});

// Base units are re-derived in angle-pool order, never ledger order, so a
// reordered perAngle gives the same verdict as the dispatched order.
const SHIPPED_DEVLOOPS = ["version: 1", "gates:", "  requireFanoutEvidence: true", "  requireFanoutProvenance: true", ""].join("\n");
const reorderings = (entries) => [
  ["reversed", [...entries].reverse()],
  ["shuffled", [...entries.filter((_, i) => i % 3 === 2), ...entries.filter((_, i) => i % 3 === 0), ...entries.filter((_, i) => i % 3 === 1)]],
];

async function writeUnpacked(dir, gate, perAngle) {
  try {
    const result = await writeGateFindingsLog({
      repo: "owner/repo", pr: 5, gate, headSha: HEAD_SHA, verdict: "clean", findings: "[]",
      provenance: JSON.stringify({ distinctReviewers: countIds(perAngle), perAngle }),
      tmpRoot: OUT,
    }, { repoRoot: dir });
    return { error: null, provenance: result.log.provenance };
  } catch (error) {
    return { error: error.message, provenance: null };
  }
}

describe("fanoutReviewerPairingError is independent of ledger order", () => {
  test("22-angle packed draft round: reversed and shuffled perAngle pass both checks; a cross-unit share still fails", async () => {
    await withConfig(SHIPPED_DEVLOOPS, async (dir, config) => {
      const { pool } = resolveGateAngleContract(config, "draft");
      assert.equal(pool.length, 22);
      const plan = resolveFanoutDispatch(config, "draft", pool, { env: { CLAUDECODE: "1" } });
      const units = expandDispatchUnits(plan.groups, new Set(config.gates.fanout.groups.map((g) => g.name)));
      const perAngle = perUnitProvenance(units);
      for (const [label, reordered] of reorderings(perAngle)) {
        const { error, provenance } = await writePacked(dir, "draft_gate", plan.groups, reordered);
        assert.equal(error, null, label);
        assert.equal(await readPacked(dir, "draft_gate", provenance), null, label);
      }
      const [first, second] = units;
      const shared = perAngle.map((e) => (e.angle === second.angles[0] ? { ...e, reviewer: "r0", group: first.group } : e));
      for (const [label, reordered] of reorderings(shared)) {
        const { error } = await writePacked(dir, "draft_gate", plan.groups, reordered);
        assert.match(error ?? "", /recorded dispatch units does not place all of them in one group/, label);
        const dispatchUnits = units.map(({ name, angles }) => ({ name, angles }));
        const read = await readPacked(dir, "draft_gate", { distinctReviewers: countIds(reordered), perAngle: reordered, dispatchUnits });
        assert.match(read ?? "", /recorded dispatch units does not place all of them in one group/, label);
      }
    });
  });

  test("17-angle unpacked draft round without recorded membership: reversed and shuffled perAngle pass both checks; a cross-unit share still fails", async () => {
    await withConfig(SHIPPED_DEVLOOPS, async (dir, config) => {
      const angles = resolveGateAngleContract(config, "draft").pool.slice(0, 17);
      const units = expandDispatchUnits(resolveFanoutGroups(config, "draft", angles), new Set(config.gates.fanout.groups.map((g) => g.name)));
      const perAngle = perUnitProvenance(units);
      for (const [label, reordered] of reorderings(perAngle)) {
        const { error, provenance } = await writeUnpacked(dir, "draft_gate", reordered);
        assert.equal(error, null, label);
        assert.equal(provenance.dispatchUnits, undefined, label);
        assert.equal(await readPacked(dir, "draft_gate", provenance), null, label);
      }
      const multi = units.filter((u) => u.angles.length > 1);
      const [host, other] = [multi[0], units.find((u) => u !== multi[0])];
      const shared = perAngle.map((e) => (e.angle === other.angles[0] ? { ...e, reviewer: `r${units.indexOf(host)}`, group: host.group } : e));
      for (const [label, reordered] of reorderings(shared)) {
        const { error } = await writeUnpacked(dir, "draft_gate", reordered);
        assert.match(error ?? "", /does not place all of them in one group \(no recorded dispatch membership\)/, label);
        const read = await readPacked(dir, "draft_gate", { distinctReviewers: countIds(reordered), perAngle: reordered });
        assert.match(read ?? "", /does not place all of them in one group \(no recorded dispatch membership\)/, label);
      }
    });
  });
});
